class UniversalOverrideMulti:
    """
    One node, multiple typed ports.
    - You can connect multiple INTs/FLOATs/STRINGs/BOOLEANs (up to N each).
    - Each type has a mode:
        * passthrough_if_connected: if input connected -> output input, else widget default
        * force_widget: always output widget values
        * force_input: always output input values (falls back to widget if not connected)
    """

    MAX_PORTS = 8  # change if you want more than 8 of each type

    @classmethod
    def INPUT_TYPES(cls):
        required = {
            # modes
            "int_mode":   (["passthrough_if_connected", "force_widget", "force_input"],),
            "float_mode": (["passthrough_if_connected", "force_widget", "force_input"],),
            "str_mode":   (["passthrough_if_connected", "force_widget", "force_input"],),
            "bool_mode":  (["passthrough_if_connected", "force_widget", "force_input"],),
        }

        # widget defaults (so the node is useful even with nothing connected)
        for i in range(1, cls.MAX_PORTS + 1):
            required[f"int_value_{i}"] = ("INT", {"default": 0, "min": -999999999, "max": 999999999, "step": 1})
            required[f"float_value_{i}"] = ("FLOAT", {"default": 0.0, "min": -1e9, "max": 1e9, "step": 0.01})
            required[f"str_value_{i}"] = ("STRING", {"default": ""})
            required[f"bool_value_{i}"] = ("BOOLEAN", {"default": False})

        # optional inputs (connect any subset)
        optional = {}
        for i in range(1, cls.MAX_PORTS + 1):
            optional[f"int_in_{i}"] = ("INT",)
            optional[f"float_in_{i}"] = ("FLOAT",)
            optional[f"str_in_{i}"] = ("STRING",)
            optional[f"bool_in_{i}"] = ("BOOLEAN",)

        return {"required": required, "optional": optional}

    # Return N of each type
    RETURN_TYPES = (("INT",) * MAX_PORTS) + (("FLOAT",) * MAX_PORTS) + (("STRING",) * MAX_PORTS) + (("BOOLEAN",) * MAX_PORTS)
    RETURN_NAMES = (
        tuple([f"int_out_{i}" for i in range(1, MAX_PORTS + 1)]) +
        tuple([f"float_out_{i}" for i in range(1, MAX_PORTS + 1)]) +
        tuple([f"str_out_{i}" for i in range(1, MAX_PORTS + 1)]) +
        tuple([f"bool_out_{i}" for i in range(1, MAX_PORTS + 1)])
    )

    FUNCTION = "run"
    CATEGORY = "utils/override"

    def _pick(self, mode, widget_value, connected_value, is_connected: bool):
        if mode == "force_widget":
            return widget_value
        if mode == "force_input":
            return connected_value if is_connected else widget_value
        # passthrough_if_connected
        return connected_value if is_connected else widget_value

    def run(self, int_mode, float_mode, str_mode, bool_mode, **kwargs):
        ints = []
        floats = []
        strs = []
        bools = []

        for i in range(1, self.MAX_PORTS + 1):
            w = int(kwargs[f"int_value_{i}"])
            key = f"int_in_{i}"
            is_conn = key in kwargs and kwargs[key] is not None
            v = int(kwargs[key]) if is_conn else None
            ints.append(int(self._pick(int_mode, w, v, is_conn)))

        for i in range(1, self.MAX_PORTS + 1):
            w = float(kwargs[f"float_value_{i}"])
            key = f"float_in_{i}"
            is_conn = key in kwargs and kwargs[key] is not None
            v = float(kwargs[key]) if is_conn else None
            floats.append(float(self._pick(float_mode, w, v, is_conn)))

        for i in range(1, self.MAX_PORTS + 1):
            w = str(kwargs[f"str_value_{i}"])
            key = f"str_in_{i}"
            is_conn = key in kwargs and kwargs[key] is not None
            v = str(kwargs[key]) if is_conn else None
            strs.append(str(self._pick(str_mode, w, v, is_conn)))

        for i in range(1, self.MAX_PORTS + 1):
            w = bool(kwargs[f"bool_value_{i}"])
            key = f"bool_in_{i}"
            is_conn = key in kwargs and kwargs[key] is not None
            v = bool(kwargs[key]) if is_conn else None
            bools.append(bool(self._pick(bool_mode, w, v, is_conn)))

        return tuple(ints + floats + strs + bools)


NODE_CLASS_MAPPINGS = {
    "Universal Override (Multi)": UniversalOverrideMulti,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "Universal Override (Multi)": "Universal Override (Multi)",
}