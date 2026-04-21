__version__ = "1.0.2"

# 初始化节点映射
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

# 导入所有节点模块
from .imageconcante_V1 import NODE_CLASS_MAPPINGS as concate_mappings, NODE_DISPLAY_NAME_MAPPINGS as concate_display_mappings
NODE_CLASS_MAPPINGS.update(concate_mappings)
NODE_DISPLAY_NAME_MAPPINGS.update(concate_display_mappings)

# 导出变量
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]