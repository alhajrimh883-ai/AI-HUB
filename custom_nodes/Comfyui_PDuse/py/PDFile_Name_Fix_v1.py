import os
import comfy.utils

class name_fix:
    """
    文件批量重命名节点
    支持两种重命名模式：
    1. 完全重命名：使用新的文件名
    2. 添加前缀：保留原文件名，添加前缀
    """
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "folder_path": ("STRING", {"default": ""}),
                "new_name": ("STRING", {"default": ""}),
                "prefix": ("STRING", {"default": ""}),
            }
        }
    
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("result_info",)
    FUNCTION = "rename_files"
    CATEGORY = "ZHO Tools"

    def rename_files(self, folder_path, new_name="", prefix=""):
        """
        重命名文件夹中的文件
        
        Args:
            folder_path (str): 目标文件夹路径
            new_name (str): 新的文件名（如果提供，将完全替换原文件名）
            prefix (str): 要添加的前缀（如果提供，将在原文件名前添加）
            
        Returns:
            tuple: 包含操作结果的字符串
        """
        result = {
            "success": [],
            "errors": [],
            "total_processed": 0
        }
        
        if not os.path.exists(folder_path):
            return (f"错误: 文件夹路径不存在 - {folder_path}",)
            
        try:
            # 获取文件夹中的所有文件
            files = [f for f in os.listdir(folder_path) if os.path.isfile(os.path.join(folder_path, f))]
            
            if not files:
                return ("提示: 文件夹为空，没有文件需要处理",)
            
            # 检查是否同时提供了新文件名和前缀
            if new_name and prefix:
                return ("错误: 不能同时使用新文件名和前缀，请只选择其中一种方式",)
                
            for index, filename in enumerate(files, 1):
                file_path = os.path.join(folder_path, filename)
                
                # 分离文件名和扩展名
                name, ext = os.path.splitext(filename)
                
                # 构建新文件名
                if new_name:
                    # 如果提供了新文件名，使用新文件名+序号+原扩展名
                    new_name_with_ext = f"{new_name}_{index}{ext}"
                elif prefix:
                    # 如果提供了前缀，在原文件名前添加前缀
                    new_name_with_ext = f"{prefix}{name}{ext}"
                else:
                    # 如果没有提供任何参数，跳过该文件
                    continue
                
                new_path = os.path.join(folder_path, new_name_with_ext)
                
                try:
                    os.rename(file_path, new_path)
                    result["success"].append({
                        "original": filename,
                        "new_name": new_name_with_ext
                    })
                    result["total_processed"] += 1
                except Exception as e:
                    result["errors"].append({
                        "filename": filename,
                        "error": str(e)
                    })
            
            # 构建结果信息
            success_count = len(result["success"])
            error_count = len(result["errors"])
            
            report = f"操作完成\n成功: {success_count}\n失败: {error_count}"
            
            if success_count > 0:
                report += "\n\n成功重命名的文件:\n"
                report += "\n".join([f" - {item['original']} → {item['new_name']}" for item in result["success"]])
            
            if error_count > 0:
                report += "\n\n失败的文件:\n"
                report += "\n".join([f" - {item['filename']}: {item['error']}" for item in result["errors"]])
            
            return (report,)
                
        except Exception as e:
            return (f"严重错误: {str(e)}",)

# 在 ComfyUI 中的节点映射配置
NODE_CLASS_MAPPINGS = {"PDFile_name_fix": name_fix}
# 设置节点在 UI 中显示的名称
NODE_DISPLAY_NAME_MAPPINGS = {"PDFile_name_fix": "PDFile_Name_Fix_v1"} 