"""声学计算核心：按频带使用 Sabine 公式计算 RT60。

RT60 = 0.161 * V / A
其中 V 为房间体积 (m³)，A 为该频带下的等效吸声面积 (m²)：
A_band = Σ (材料面积_i × 吸声系数_i,band)
"""

BANDS = [125, 250, 500, 1000, 2000]
SABINE_K = 0.161
# RT60 显示上限（秒），避免吸声量为 0 时出现无穷大
RT60_CAP = 20.0


def absorption_areas(materials: list[dict]) -> dict[int, float]:
    """各频带的总等效吸声面积 A (m²)。"""
    areas = {}
    for band in BANDS:
        key = str(band)
        areas[band] = sum(m["area"] * m["coeffs"][key] for m in materials)
    return areas


def band_rt60(volume: float, materials: list[dict]) -> dict[int, float | None]:
    """各频带 RT60 (秒)。吸声面积为 0 时返回 None（视为无穷大）。"""
    result = {}
    for band, a in absorption_areas(materials).items():
        if a <= 1e-9:
            result[band] = None
        else:
            result[band] = round(SABINE_K * volume / a, 3)
    return result


def evaluate(rt60: dict[int, float | None], tmin: float, tmax: float):
    """对照目标区间评估各频带。

    返回 (per_band, ok_count, total_violation)：
    - per_band: {band: {"rt60", "in_range", "violation"}}
    - violation: 超出区间的距离（区间内为 0），越小越好
    """
    per_band = {}
    ok_count = 0
    total_violation = 0.0
    for band, rt in rt60.items():
        rt_eff = rt if rt is not None else float("inf")
        violation = max(0.0, rt_eff - tmax) + max(0.0, tmin - rt_eff)
        in_range = violation <= 1e-9
        per_band[band] = {
            "rt60": rt,
            "in_range": in_range,
            "violation": round(violation, 4),
        }
        total_violation += violation
        ok_count += int(in_range)
    return per_band, ok_count, round(total_violation, 4)
