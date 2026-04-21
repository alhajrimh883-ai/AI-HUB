"""
Timestep scheduler for RefAttn.
Controls how much identity injection happens at each denoising step.

Key insight: Early steps decide composition (prompt should dominate),
late steps decide detail/texture (identity can be stronger).
"""

import math
from typing import Callable


def make_scheduler(
    mode: str = "balanced",
    strength: float = 0.6,
    start_percent: float = 0.0,
    end_percent: float = 1.0,
    segment_index: int = 0,
    drift_compensation: str = "auto",
) -> Callable[[int, int], float]:
    """
    Create a scheduler function.

    Args:
        mode: Schedule curve type
            - "balanced": Sine curve, low at start/end, peaks in middle
            - "identity_heavy": Ramps up, strong identity throughout
            - "prompt_heavy": Low identity, minimal injection
            - "front_loaded": Strong at start, fades out
            - "constant": Flat injection at strength value
        strength: Global multiplier [0.0, 1.0]
        start_percent: When to start injection (0.0 = beginning)
        end_percent: When to stop injection (1.0 = end)
        segment_index: Current segment number (for drift compensation)
        drift_compensation: "auto", "off", or "manual"

    Returns:
        Callable(current_step, total_steps) -> weight
    """

    # Drift compensation: slightly boost identity for later segments
    drift_boost = 0.0
    if drift_compensation == "auto" and segment_index > 0:
        drift_boost = min(0.02 * segment_index, 0.15)

    def scheduler(current_step: int, total_steps: int) -> float:
        if total_steps <= 0:
            return 0.0

        progress = current_step / max(total_steps - 1, 1)

        # Outside active range — no injection
        if progress < start_percent or progress > end_percent:
            return 0.0

        # Normalize progress within the active window
        window_size = end_percent - start_percent
        if window_size <= 0:
            return 0.0
        local_progress = (progress - start_percent) / window_size

        # Compute base weight from curve
        if mode == "balanced":
            # Sine curve: peaks at 50% of the active window
            base = math.sin(local_progress * math.pi)

        elif mode == "identity_heavy":
            # Starts moderate, ramps up
            base = 0.4 + 0.6 * local_progress

        elif mode == "prompt_heavy":
            # Low throughout, small bump in middle
            base = 0.15 + 0.2 * math.sin(local_progress * math.pi)

        elif mode == "front_loaded":
            # Strong at start, fades
            base = 1.0 - local_progress * 0.7

        elif mode == "constant":
            base = 1.0

        else:
            base = math.sin(local_progress * math.pi)  # default to balanced

        # Apply strength multiplier and drift compensation
        weight = base * min(strength + drift_boost, 1.0)

        return max(0.0, min(1.0, weight))

    return scheduler


def preview_schedule(
    mode: str = "balanced",
    strength: float = 0.6,
    start_percent: float = 0.0,
    end_percent: float = 1.0,
    total_steps: int = 30,
    segment_index: int = 0,
) -> list:
    """
    Preview the injection weights for each step.
    Useful for debugging and visualization.

    Returns:
        List of (step, weight) tuples
    """
    fn = make_scheduler(mode, strength, start_percent, end_percent, segment_index)
    return [(step, fn(step, total_steps)) for step in range(total_steps)]
