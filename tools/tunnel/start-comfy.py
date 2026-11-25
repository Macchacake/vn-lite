"""
稳定启动 ComfyUI（vn-lite 生图后端）。

背景：RTX 4060 Laptop 8G 跑 SDXL 时 ComfyUI 会段错误崩溃（exit 139）。
实测根因是**系统物理内存不足**（这台机器 15.6G 内存常被开发工具占满，空闲不足 2G，
Pages/sec 高达 1600+，SDXL 加载需要 4-6G，内存耗尽导致进程崩溃），不是显存分配器本身。
所以生图前请尽量关闭多余的浏览器标签 / Trae / ChatGPT 等，保证有 6G 以上空闲内存。

启动参数说明：
  --disable-cuda-malloc  这张卡官方建议关闭 cudaMallocAsync；且不能用 shell 的
                         PYTORCH_CUDA_ALLOC_CONF=backend:native 覆盖，因为 cuda_malloc.py
                         会往该变量「追加」backend:cudaMallocAsync，两个 backend 并存会触发
                         PyTorch 的 "Allocator backend parsed at runtime != load time" 断言。
  --lowvram              8G 显存跑 SDXL 必须。

用法：
    D:/ComfyUI/venv/Scripts/python.exe C:/Users/ASUS/Desktop/vn-lite/tools/tunnel/start-comfy.py
"""
import os
import runpy
import sys

COMFY_DIR = r"D:\ComfyUI"
MAIN = os.path.join(COMFY_DIR, "main.py")

ARGS = [
    "main.py",
    "--listen", "0.0.0.0",
    "--port", "8188",
    "--enable-cors-header", "*",
    "--disable-cuda-malloc",  # 禁用 cudaMallocAsync（这张卡官方建议关闭）
    "--lowvram",              # 8G 显存跑 SDXL 必须
]

os.chdir(COMFY_DIR)
# runpy 从外部脚本路径启动时不会把 ComfyUI 目录加入模块搜索路径，手动补上
sys.path.insert(0, COMFY_DIR)
sys.argv = ARGS
runpy.run_path(MAIN, run_name="__main__")
