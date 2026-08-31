from __future__ import annotations

import math


class LowPassFilter:
    def __init__(self) -> None:
        self._value: float | None = None

    def apply(self, value: float, alpha: float) -> float:
        if self._value is None:
            self._value = value
        else:
            self._value = alpha * value + (1.0 - alpha) * self._value
        return self._value

    def reset(self) -> None:
        self._value = None


class OneEuroFilter:
    """Adaptive low-pass filter with low jitter and limited motion lag."""

    def __init__(
        self,
        min_cutoff: float = 1.2,
        beta: float = 0.035,
        derivative_cutoff: float = 1.0,
    ) -> None:
        if min_cutoff <= 0 or derivative_cutoff <= 0:
            raise ValueError("Filter cutoff frequencies must be positive")
        self.min_cutoff = min_cutoff
        self.beta = beta
        self.derivative_cutoff = derivative_cutoff
        self._signal = LowPassFilter()
        self._derivative = LowPassFilter()
        self._previous_raw: float | None = None
        self._previous_time: float | None = None

    @staticmethod
    def _alpha(cutoff: float, dt: float) -> float:
        tau = 1.0 / (2.0 * math.pi * cutoff)
        return 1.0 / (1.0 + tau / dt)

    def apply(self, value: float, timestamp_s: float) -> float:
        if self._previous_time is None or timestamp_s <= self._previous_time:
            self._previous_raw = value
            self._previous_time = timestamp_s
            return self._signal.apply(value, 1.0)

        dt = max(timestamp_s - self._previous_time, 1e-6)
        derivative = (value - self._previous_raw) / dt
        filtered_derivative = self._derivative.apply(
            derivative, self._alpha(self.derivative_cutoff, dt)
        )
        cutoff = self.min_cutoff + self.beta * abs(filtered_derivative)
        filtered = self._signal.apply(value, self._alpha(cutoff, dt))
        self._previous_raw = value
        self._previous_time = timestamp_s
        return filtered

    def reset(self) -> None:
        self._signal.reset()
        self._derivative.reset()
        self._previous_raw = None
        self._previous_time = None


class PositionFilter:
    def __init__(self, min_cutoff: float, beta: float, derivative_cutoff: float) -> None:
        args = (min_cutoff, beta, derivative_cutoff)
        self.x = OneEuroFilter(*args)
        self.y = OneEuroFilter(*args)
        self.z = OneEuroFilter(*args)

    def apply(
        self, x: float, y: float, z: float, timestamp_s: float
    ) -> tuple[float, float, float]:
        return (
            self.x.apply(x, timestamp_s),
            self.y.apply(y, timestamp_s),
            self.z.apply(z, timestamp_s),
        )

    def reset(self) -> None:
        self.x.reset()
        self.y.reset()
        self.z.reset()

