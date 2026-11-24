# ComfyUI-VNL-Matte
# 给文游Lite 用的最小抠图节点：ONNX 动漫人像分割（isnet-anime / u2net 等）。
# 只依赖 onnxruntime + numpy + Pillow，不碰 torch，不会污染现有环境。
#
# 输出是「前景掩膜」（1 = 人物，0 = 背景），和 ComfyUI 0.37+ 原生
# RemoveBackground 的语义一致，方便插件端统一处理。

import os
import numpy as np
import torch
from PIL import Image

import folder_paths

NODE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_SUBDIR = "background_removal"


def _model_dir():
    base = getattr(folder_paths, "models_dir", os.path.join(os.path.dirname(NODE_DIR), "models"))
    d = os.path.join(base, MODEL_SUBDIR)
    os.makedirs(d, exist_ok=True)
    return d


def _list_models():
    d = _model_dir()
    try:
        names = [f for f in os.listdir(d) if f.lower().endswith((".onnx", ".pth"))]
    except OSError:
        names = []
    return sorted(names)


# 会话缓存：同一个模型只加载一次（176MB 的 onnx 加载一次要好几秒）
_SESSIONS = {}


def _get_session(path):
    if path in _SESSIONS:
        return _SESSIONS[path]
    import onnxruntime as ort
    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    so.intra_op_num_threads = max(1, (os.cpu_count() or 4) - 1)
    sess = ort.InferenceSession(path, sess_options=so, providers=["CPUExecutionProvider"])
    _SESSIONS[path] = sess
    return sess


def _to_pil(img_tensor):
    """ComfyUI IMAGE [B,H,W,C] float 0..1 -> 单张 PIL"""
    t = img_tensor
    if t.dim() == 4:
        t = t[0]
    arr = (t.clamp(0, 1).cpu().numpy() * 255.0).round().astype(np.uint8)
    if arr.ndim == 2:
        return Image.fromarray(arr, mode="L").convert("RGB")
    return Image.fromarray(arr[:, :, :3], mode="RGB")


def _infer_mask(sess, pil, size=1024):
    """返回和原图同尺寸的 float32 掩膜（0..1，1=前景）"""
    mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
    std = np.array([0.229, 0.224, 0.225], dtype=np.float32)

    im = pil.convert("RGB").resize((size, size), Image.LANCZOS)
    a = np.asarray(im, dtype=np.float32) / 255.0
    # u2net / isnet 家族的标准预处理：先整体除以最大值，再按 ImageNet 均值方差归一
    mx = float(a.max()) or 1.0
    a = a / mx
    a = (a - mean) / std
    a = a.transpose((2, 0, 1))
    x = np.expand_dims(a, 0).astype(np.float32)

    inp = sess.get_inputs()[0].name
    outs = sess.run(None, {inp: x})
    pred = np.asarray(outs[0])
    if pred.ndim == 4:
        pred = pred[:, 0, :, :]
    pred = pred[0]
    lo, hi = float(pred.min()), float(pred.max())
    pred = (pred - lo) / (hi - lo) if hi > lo else np.zeros_like(pred)
    mask = Image.fromarray((pred * 255.0).astype(np.uint8), mode="L")
    mask = mask.resize(pil.size, Image.LANCZOS)
    return np.asarray(mask, dtype=np.float32) / 255.0


def _detect_key(arr):
    """从图像四边猜绿幕主色通道：0=R 1=G 2=B"""
    h, w, _ = arr.shape
    band = 6
    edge = np.concatenate([
        arr[:band].reshape(-1, 3), arr[-band:].reshape(-1, 3),
        arr[:, :band].reshape(-1, 3), arr[:, -band:].reshape(-1, 3),
    ])
    mean = edge.mean(axis=0)
    return int(np.argmax(mean))


def _despill(arr, alpha, dom, strength=1.0):
    """
    去溢色：把主色通道压到另外两个通道的最大值。
    只在半透明区域下重手（不透明的绿衣服不该被改），
    这是绿幕边缘发绿的根本原因。
    """
    if dom is None:
        return arr
    out = arr.copy()
    others = [c for c in (0, 1, 2) if c != dom]
    cap = np.maximum(out[:, :, others[0]], out[:, :, others[1]])
    spill = np.maximum(0.0, out[:, :, dom] - cap)
    # alpha 越低越可能是溢色：alpha<=0.25 全量去，alpha>=0.9 基本不动
    f = np.clip((0.9 - alpha) / 0.65, 0.0, 1.0) * float(strength)
    out[:, :, dom] = out[:, :, dom] - spill * f
    return np.clip(out, 0.0, 1.0)


class VNLLoadMatte:
    @classmethod
    def INPUT_TYPES(cls):
        models = _list_models()
        return {
            "required": {
                "matte_name": (models, {"default": models[0] if models else ""}),
            }
        }

    RETURN_TYPES = ("VNL_MATTE",)
    RETURN_NAMES = ("matte",)
    FUNCTION = "load"
    CATEGORY = "VN-Lite"

    def load(self, matte_name):
        path = os.path.join(_model_dir(), matte_name)
        if not os.path.isfile(path):
            raise FileNotFoundError("找不到抠图模型：" + path)
        return (path,)


class VNLMatte:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "matte": ("VNL_MATTE",),
                "image": ("IMAGE",),
            },
            "optional": {
                "despill": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 2.0, "step": 0.05}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    FUNCTION = "run"
    CATEGORY = "VN-Lite"

    def run(self, matte, image, despill=1.0):
        sess = _get_session(matte)
        batch = image.shape[0] if image.dim() == 4 else 1
        imgs, masks = [], []
        for i in range(batch):
            t = image[i] if image.dim() == 4 else image
            pil = _to_pil(t)
            m = _infer_mask(sess, pil)

            arr = (t.clamp(0, 1).cpu().numpy() * 255.0).round().astype(np.uint8)
            if arr.ndim == 2:
                arr = np.stack([arr] * 3, axis=-1)
            arr = arr[:, :, :3]

            if despill > 0:
                dom = _detect_key(arr)
                fixed = _despill(arr.astype(np.float32) / 255.0, m, dom, despill)
                arr = (fixed * 255.0).round().astype(np.uint8)

            imgs.append(torch.from_numpy(arr.astype(np.float32) / 255.0))
            masks.append(torch.from_numpy(m))

        return (torch.stack(imgs, dim=0), torch.stack(masks, dim=0))


NODE_CLASS_MAPPINGS = {
    "VNLLoadMatte": VNLLoadMatte,
    "VNLMatte": VNLMatte,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VNLLoadMatte": "VN-Lite 抠图模型加载",
    "VNLMatte": "VN-Lite 自动抠图（人像分割）",
}
