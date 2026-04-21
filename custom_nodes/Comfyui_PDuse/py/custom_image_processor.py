"""
ComfyUI 简化图像处理节点
移除复杂依赖，避免导入错误
"""

import torch
import numpy as np

# 安全导入ComfyUI模块
try:
    import folder_paths
except ImportError:
    folder_paths = None

class PD_SimpleImageProcessor:
    """简化的图像处理节点"""
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "brightness": ("FLOAT", {
                    "default": 1.0,
                    "min": 0.0,
                    "max": 2.0,
                    "step": 0.1
                }),
            }
        }
    
    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("processed_images", "info")
    FUNCTION = "process"
    CATEGORY = "PD/图像处理"

    def process_images(
        self, 
        images: torch.Tensor, 
        process_type: str = "blur",
        strength: float = 1.0,
        enable_batch: bool = True,
        mask: Optional[torch.Tensor] = None,
        custom_value: int = 50
    ) -> Tuple[torch.Tensor, torch.Tensor, str]:
        """
        5. 主要图像处理函数
        
        参数：
        - images: 输入图像张量 (B, H, W, C)
        - process_type: 处理类型
        - strength: 处理强度
        - enable_batch: 是否启用批处理
        - mask: 可选遮罩 (B, H, W)
        - custom_value: 自定义数值
        
        返回：
        - 处理后的图像 (B, H, W, C)
        - 输出遮罩 (B, H, W)  
        - 信息文本
        """
        
        try:
            # 6. 输入验证和张量形状检查
            if not isinstance(images, torch.Tensor):
                raise ValueError("输入必须是torch.Tensor类型")
            
            if len(images.shape) != 4:
                raise ValueError(f"图像张量必须是4维 (B,H,W,C)，当前形状: {images.shape}")
            
            batch_size, height, width, channels = images.shape
            print(f"处理图像形状: B={batch_size}, H={height}, W={width}, C={channels}")
            
            # 7. 张量格式转换 - 从ComfyUI格式 (B,H,W,C) 转换为处理格式
            processed_images = []
            output_masks = []
            
            for i in range(batch_size):
                # 提取单张图像 (H, W, C)
                single_image = images[i]
                
                # 转换为numpy格式进行处理 (H, W, C) -> numpy array
                image_np = self._tensor_to_numpy(single_image)
                
                # 8. 执行具体的图像处理
                processed_np = self._apply_image_processing(
                    image_np, process_type, strength, custom_value
                )
                
                # 9. 处理遮罩（如果提供）
                if mask is not None:
                    mask_np = self._mask_tensor_to_numpy(mask[i])  # (H, W)
                    processed_np = self._apply_mask(processed_np, mask_np)
                    output_mask = self._numpy_to_mask_tensor(mask_np)
                else:
                    # 创建默认遮罩
                    output_mask = torch.ones((height, width), dtype=torch.float32)
                
                # 10. 转换回张量格式
                processed_tensor = self._numpy_to_tensor(processed_np)
                
                processed_images.append(processed_tensor)
                output_masks.append(output_mask)
                
                if not enable_batch:
                    break
            
            # 11. 合并批处理结果，保持 (B, H, W, C) 格式
            result_images = torch.stack(processed_images, dim=0)
            result_masks = torch.stack(output_masks, dim=0)  # (B, H, W) 格式
            
            # 12. 生成信息文本
            info_text = f"处理完成: {process_type}, 强度: {strength}, 批次: {len(processed_images)}"
            
            print(f"输出图像形状: {result_images.shape}")
            print(f"输出遮罩形状: {result_masks.shape}")
            
            return (result_images, result_masks, info_text)
            
        except Exception as e:
            print(f"图像处理错误: {str(e)}")
            # 返回原始图像和错误信息
            error_mask = torch.zeros((batch_size, height, width), dtype=torch.float32)
            return (images, error_mask, f"处理失败: {str(e)}")
    
    def _tensor_to_numpy(self, tensor: torch.Tensor) -> np.ndarray:
        """
        13. 张量转numpy数组
        从 (H, W, C) torch tensor 转换为 (H, W, C) numpy array
        值范围从 [0,1] 转换为 [0,255]
        """
        # 确保张量在CPU上
        if tensor.is_cuda:
            tensor = tensor.cpu()
        
        # 转换为numpy并调整值范围
        numpy_array = tensor.detach().numpy()
        numpy_array = (numpy_array * 255).astype(np.uint8)
        
        return numpy_array
    
    def _numpy_to_tensor(self, numpy_array: np.ndarray) -> torch.Tensor:
        """
        14. numpy数组转张量
        从 (H, W, C) numpy array 转换为 (H, W, C) torch tensor
        值范围从 [0,255] 转换为 [0,1]
        """
        # 转换为浮点数并归一化
        tensor = torch.from_numpy(numpy_array.astype(np.float32) / 255.0)
        return tensor
    
    def _mask_tensor_to_numpy(self, mask_tensor: torch.Tensor) -> np.ndarray:
        """
        15. 遮罩张量转numpy
        从 (H, W) torch tensor 转换为 (H, W) numpy array
        """
        if mask_tensor.is_cuda:
            mask_tensor = mask_tensor.cpu()
        
        mask_np = mask_tensor.detach().numpy()
        return (mask_np * 255).astype(np.uint8)
    
    def _numpy_to_mask_tensor(self, mask_np: np.ndarray) -> torch.Tensor:
        """
        16. numpy转遮罩张量
        从 (H, W) numpy array 转换为 (H, W) torch tensor
        """
        mask_tensor = torch.from_numpy(mask_np.astype(np.float32) / 255.0)
        return mask_tensor
    
    def _apply_image_processing(
        self, 
        image_np: np.ndarray, 
        process_type: str, 
        strength: float,
        custom_value: int
    ) -> np.ndarray:
        """
        17. 应用具体的图像处理效果
        
        参数：
        - image_np: numpy图像数组 (H, W, C)
        - process_type: 处理类型
        - strength: 处理强度
        - custom_value: 自定义参数
        
        返回：
        - 处理后的numpy图像数组
        """
        
        # 转换为PIL图像进行处理
        pil_image = Image.fromarray(image_np)
        
        if process_type == "blur":
            # 模糊处理
            radius = max(0.1, strength * 2.0)
            pil_image = pil_image.filter(ImageFilter.GaussianBlur(radius=radius))
            
        elif process_type == "sharpen":
            # 锐化处理
            enhancer = ImageEnhance.Sharpness(pil_image)
            pil_image = enhancer.enhance(1.0 + strength)
            
        elif process_type == "brightness":
            # 亮度调整
            enhancer = ImageEnhance.Brightness(pil_image)
            pil_image = enhancer.enhance(1.0 + (strength - 1.0) * 0.5)
            
        elif process_type == "contrast":
            # 对比度调整
            enhancer = ImageEnhance.Contrast(pil_image)
            pil_image = enhancer.enhance(1.0 + (strength - 1.0) * 0.5)
            
        elif process_type == "edge_detection":
            # 边缘检测
            pil_image = pil_image.filter(ImageFilter.FIND_EDGES)
            
        elif process_type == "noise_reduction":
            # 噪声减少（使用中值滤波）
            cv_image = cv2.cvtColor(np.array(pil_image), cv2.COLOR_RGB2BGR)
            kernel_size = max(3, int(strength * 5))
            if kernel_size % 2 == 0:
                kernel_size += 1
            cv_image = cv2.medianBlur(cv_image, kernel_size)
            pil_image = Image.fromarray(cv2.cvtColor(cv_image, cv2.COLOR_BGR2RGB))
        
        # 转换回numpy数组
        return np.array(pil_image)
    
    def _apply_mask(self, image_np: np.ndarray, mask_np: np.ndarray) -> np.ndarray:
        """
        18. 应用遮罩到图像
        
        参数：
        - image_np: 图像数组 (H, W, C)
        - mask_np: 遮罩数组 (H, W)
        
        返回：
        - 应用遮罩后的图像
        """
        # 确保遮罩维度正确
        if len(mask_np.shape) == 2:
            mask_np = np.expand_dims(mask_np, axis=2)  # (H, W) -> (H, W, 1)
        
        # 归一化遮罩到 [0, 1] 范围
        mask_normalized = mask_np.astype(np.float32) / 255.0
        
        # 应用遮罩
        result = image_np.astype(np.float32) * mask_normalized
        
        return result.astype(np.uint8)


class PD_ImageBatchSplitter:
    """
    19. 图像批处理分割节点
    将批处理图像分割为单独的图像
    """
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),  # (B, H, W, C)
                "split_index": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 100,
                    "step": 1
                })
            }
        }
    
    RETURN_TYPES = ("IMAGE", "INT")
    RETURN_NAMES = ("single_image", "batch_count")
    FUNCTION = "split_batch"
    CATEGORY = "PD/工具"
    
    def split_batch(self, images: torch.Tensor, split_index: int = 0):
        """分割批处理图像"""
        batch_size = images.shape[0]
        
        # 确保索引在有效范围内
        if split_index >= batch_size:
            split_index = batch_size - 1
        
        # 提取指定索引的图像，保持4维形状 (1, H, W, C)
        single_image = images[split_index:split_index+1]
        
        return (single_image, batch_size)


class PD_ImageInfo:
    """
    20. 图像信息获取节点
    获取图像的详细信息
    """
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
            }
        }
    
    RETURN_TYPES = ("STRING", "INT", "INT", "INT", "INT")
    RETURN_NAMES = ("info_text", "batch_size", "height", "width", "channels")
    FUNCTION = "get_image_info"
    CATEGORY = "PD/工具"
    OUTPUT_NODE = True
    
    def get_image_info(self, images: torch.Tensor):
        """获取图像信息"""
        batch_size, height, width, channels = images.shape
        
        info_text = f"""
图像信息：
- 批次大小: {batch_size}
- 高度: {height}px
- 宽度: {width}px  
- 颜色通道: {channels}
- 张量形状: {images.shape}
- 数据类型: {images.dtype}
- 设备: {images.device}
- 内存使用: {images.element_size() * images.nelement() / 1024 / 1024:.2f} MB
        """.strip()
        
        print(info_text)
        
        return (info_text, batch_size, height, width, channels)


# 21. 节点类映射注册
NODE_CLASS_MAPPINGS = {
    "PD_CustomImageProcessor": PD_CustomImageProcessor,
    "PD_ImageBatchSplitter": PD_ImageBatchSplitter, 
    "PD_ImageInfo": PD_ImageInfo,
}

# 22. 节点显示名称映射
NODE_DISPLAY_NAME_MAPPINGS = {
    "PD_CustomImageProcessor": "PD自定义图像处理器",
    "PD_ImageBatchSplitter": "PD图像批处理分割",
    "PD_ImageInfo": "PD图像信息",
}

# 23. 导出变量（用于ComfyUI识别）
__all__ = ['NODE_CLASS_MAPPINGS', 'NODE_DISPLAY_NAME_MAPPINGS']

# 24. 初始化日志
if __name__ == "__main__":
    print("PD自定义图像处理节点已加载")
    print(f"注册节点数量: {len(NODE_CLASS_MAPPINGS)}")
    for name in NODE_CLASS_MAPPINGS.keys():
        print(f"- {name}") 