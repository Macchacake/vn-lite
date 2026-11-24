# ComfyUI-VNL-Matte

给 **文游Lite (VN-Lite)** 用的最小抠图节点。装上之后立绘会**直接生成真透明底 PNG**，
不再靠前端绿幕抠色，发丝边缘干净、没有绿边。

只依赖 `onnxruntime`，**不动 torch**，不会影响你现有的 ComfyUI 环境。

## 装法

```bash
# 1) 装依赖（用 ComfyUI 自己的 python）
D:\ComfyUI\venv\Scripts\python.exe -m pip install onnxruntime

# 2) 把本文件夹整个拷到 ComfyUI 的 custom_nodes 下
#    最终路径应为：D:\ComfyUI\custom_nodes\ComfyUI-VNL-Matte\__init__.py

# 3) 下模型（176MB，动漫人像分割，对二次元角色效果好）
#    存到 D:\ComfyUI\models\background_removal\isnet-anime.onnx
#    https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-anime.onnx

# 4) 重启 ComfyUI
```

重启后在酒馆里点插件的「测试连接」，输出里应该出现：

```
抠图：✓ 服务端自动抠图已启用（VN-Lite 节点 · isnet-anime.onnx）
```

看到这行就说明生效了，插件会自动把立绘的幕布从绿幕换成中性灰幕布
（灰幕布不会被半透明发梢吃进去，所以不会有一圈绿边）。

## 节点

| 节点 | 输入 | 输出 |
|---|---|---|
| `VNLLoadMatte` | `matte_name`（`models/background_removal/` 里的 .onnx） | `VNL_MATTE` |
| `VNLMatte` | `matte`, `image`, `despill`(0~2) | `image`（去过溢色）, `mask`（前景掩膜，1=人物） |

`mask` 是**前景**掩膜。如果要合成透明 PNG，记得先 `InvertMask` 再进
`JoinImageWithAlpha` —— 因为它的 alpha 语义是「透明度」而不是「不透明度」。

## 换成别的模型

`models/background_removal/` 里放任何 u2net/isnet 家族的 onnx 都行，节点会自动列出来。
`isnet-general-use.onnx` 更适合真人，`isnet-anime.onnx` 更适合二次元。

## 没装这个节点会怎样

插件会自己退回绿幕 + 浏览器端抠色，功能正常，只是边缘不如 AI 抠图干净。
不会报错，也不会卡住。
