import os
import torch
import numpy as np
from PIL import Image, ImageDraw, ImageFont

class ImageBlendText:
    """
    * 图片合并与文字标注节点
    * 将两张图片左右合并并在下方添加文字说明
    * 支持自定义字体、字号和间距调整
    """

    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(cls):
        """
        * 定义节点的输入参数类型
        * @return {dict} 包含required参数的字典
        """
        # 获取当前脚本所在目录的 fonts 子目录
        current_file = os.path.abspath(__file__)
        current_dir = os.path.dirname(current_file)
        plugin_root = os.path.dirname(current_dir)
        fonts_dir = os.path.join(plugin_root, "fonts")

        # 扫描 fonts 目录下的所有 .ttf 和 .otf 文件
        font_files = []
        if os.path.exists(fonts_dir):
            font_files = [
                f for f in os.listdir(fonts_dir)
                if f.lower().endswith(('.ttf', '.otf'))
            ]

        # 如果没有找到字体文件，则默认使用系统字体
        if not font_files:
            font_files = ["system"]  # 默认选项

        return {
            "required": {
                "image1": ("IMAGE",),  # 第一张图像，张量形状为B H W C
                "image2": ("IMAGE",),  # 第二张图像，张量形状为B H W C
                "text1": ("STRING", {"default": "before"}),  # 第一张图的文字标注
                "text2": ("STRING", {"default": "after"}),  # 第二张图的文字标注
                "font_size": ("INT", {"default": 30, "min": 10, "max": 100, "step": 1}),  # 字体大小
                "padding_up": ("INT", {"default": 20, "min": 0, "max": 100, "step": 1}),   # 上方间距
                "padding_down": ("INT", {"default": 20, "min": 0, "max": 1000, "step": 1}),  # 下方间距
                "font_file": (font_files, {"default": font_files[0]}),  # 字体文件选择
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("merged_image",)
    FUNCTION = "merge_images_with_text"
    CATEGORY = "PD/ImageProcessing"

    def merge_images_with_text(self, image1, image2, text1, text2, font_size=30, padding_up=20, padding_down=20, font_file="system"):
        """
        * 合并两张图片并添加文字标注的主要函数
        * @param {torch.Tensor} image1 - 第一张图像张量 (B, H, W, C)
        * @param {torch.Tensor} image2 - 第二张图像张量 (B, H, W, C)
        * @param {str} text1 - 第一张图的文字说明
        * @param {str} text2 - 第二张图的文字说明
        * @param {int} font_size - 字体大小
        * @param {int} padding_up - 文字区域上方间距
        * @param {int} padding_down - 文字区域下方间距
        * @param {str} font_file - 字体文件名
        * @return {tuple} 返回合并后的图像张量
        """
        
        # 转换张量为PIL图像
        img1 = self._safe_tensor_to_pil(image1)
        img2 = self._safe_tensor_to_pil(image2)

        # 计算缩放比例（以最长边为准）
        max_dimension = max(img1.width, img1.height, img2.width, img2.height)

        # 等比例缩放两张图片
        def resize_image(img):
            """
            * 等比例缩放图像到统一尺寸
            * @param {PIL.Image} img - 待缩放的图像
            * @return {PIL.Image} 缩放后的图像
            """
            ratio = max_dimension / max(img.width, img.height)
            new_width = int(img.width * ratio)
            new_height = int(img.height * ratio)
            return img.resize((new_width, new_height), Image.LANCZOS)

        img1 = resize_image(img1)
        img2 = resize_image(img2)

        # 合并图片 - 左右拼接
        merged_img = Image.new("RGB", (img1.width + img2.width, max(img1.height, img2.height)))
        merged_img.paste(img1, (0, (merged_img.height - img1.height) // 2))  # 垂直居中
        merged_img.paste(img2, (img1.width, (merged_img.height - img2.height) // 2))  # 垂直居中

        # 加载字体
        font = self._load_font(font_size, font_file)

        # 计算文本尺寸（兼容新旧Pillow版本）
        try:
            # Pillow 10.0.0+ 使用新的textlength和textbbox方法
            text1_width = font.getlength(text1)
            text2_width = font.getlength(text2)
            _, _, _, text_height = font.getbbox("Ag")  # 使用包含下行字母的文本测量高度
        except AttributeError:
            # 旧版Pillow使用getsize方法
            text1_width, text_height = font.getsize(text1)
            text2_width, _ = font.getsize(text2)

        # 创建最终图像（带文字区域）
        bg_height = text_height + padding_up + padding_down
        final_img = Image.new("RGB", (merged_img.width, merged_img.height + bg_height), "black")
        final_img.paste(merged_img, (0, 0))

        # 绘制文字
        draw = ImageDraw.Draw(final_img)
        text_y = merged_img.height + padding_up

        # 第一张图的文字居中
        text1_x = img1.width // 2 - text1_width // 2
        draw.text((text1_x, text_y), text1, font=font, fill="white")

        # 第二张图的文字居中
        text2_x = img1.width + img2.width // 2 - text2_width // 2
        draw.text((text2_x, text_y), text2, font=font, fill="white")

        # 转换回张量
        return (self._pil_to_tensor(final_img),)

    def _safe_tensor_to_pil(self, tensor):
        """
        * 安全地将张量转换为PIL图像
        * @param {torch.Tensor} tensor - 输入张量
        * @return {PIL.Image} PIL图像对象
        """
        tensor = tensor.cpu().detach()

        # 处理批次维度
        if tensor.dim() == 4:
            tensor = tensor[0]

        # 处理通道顺序
        if tensor.shape[0] <= 4:  # CHW格式
            tensor = tensor.permute(1, 2, 0)

        # 归一化处理
        if tensor.dtype == torch.float32 and tensor.max() <= 1.0:
            tensor = tensor * 255

        # 转换为uint8
        tensor = tensor.to(torch.uint8)

        # 处理单通道图像
        if tensor.dim() == 2 or tensor.shape[-1] == 1:
            tensor = tensor.unsqueeze(-1) if tensor.dim() == 2 else tensor
            tensor = torch.cat([tensor]*3, dim=-1)  # 转为RGB

        return Image.fromarray(tensor.numpy())

    def _load_font(self, font_size, font_file="system"):
        """
        * 加载字体，优先从 fonts 目录加载
        * @param {int} font_size - 字体大小
        * @param {str} font_file - 字体文件名
        * @return {ImageFont} 字体对象
        """
        if font_file == "system":
            try:
                return ImageFont.truetype("arial.ttf", font_size)
            except:
                return ImageFont.load_default()
        else:
            # 重新计算插件根目录
            current_file = os.path.abspath(__file__)
            current_dir = os.path.dirname(current_file)           # 当前 py 文件所在目录（py/）
            plugin_root = os.path.dirname(current_dir)           # 插件根目录（Comfyui_PDuse/）
            font_path = os.path.join(plugin_root, "fonts", font_file)  # 拼接字体路径

            try:
                return ImageFont.truetype(font_path, font_size)
            except Exception as e:
                print(f"⚠️ 字体加载失败: {font_file}, 回退到系统默认字体。错误: {e}")
                return ImageFont.load_default()

    def _pil_to_tensor(self, image):
        """
        * 将PIL图像转换为张量
        * @param {PIL.Image} image - PIL图像对象
        * @return {torch.Tensor} 图像张量 (1, H, W, C)
        """
        if image.mode == 'RGBA':
            image = image.convert('RGB')
        return torch.from_numpy(np.array(image).astype(np.float32) / 255.0).unsqueeze(0)

# ComfyUI节点注册映射
NODE_CLASS_MAPPINGS = {
    "ImageBlendText": ImageBlendText
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ImageBlendText": "PD:Image Blend Text"
} 