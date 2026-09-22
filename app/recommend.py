"""可解释的约束搜索：枚举“一次材料替换”，推荐使各频带尽量同时达标的方案。

搜索空间 = 房间内每个材料 × 材料库中每个候选材料（保留原铺设面积，仅替换材质）。
评分规则（字典序，全部可解释）：
  1. 达标频带数越多越好；
  2. 总违规量（各频带超出目标区间的距离之和）越小越好；
  3. 各频带 RT60 与目标区间中点的总偏差越小越好（听感更均衡）。
"""

from .acoustics import BANDS, absorption_areas, band_rt60, evaluate
from .library import LIBRARY


def _mid(tmin: float, tmax: float) -> float:
    return (tmin + tmax) / 2.0


def _balance_score(rt60: dict[int, float | None], tmin: float, tmax: float) -> float:
    mid = _mid(tmin, tmax)
    return sum(abs((rt if rt is not None else 1e6) - mid) for rt in rt60.values())


def recommend(volume: float, materials: list[dict],
              tmin: float, tmax: float) -> dict:
    before_rt = band_rt60(volume, materials)
    before_eval, before_ok, before_violation = evaluate(before_rt, tmin, tmax)
    before_abs = absorption_areas(materials)

    candidates = []
    for idx, old in enumerate(materials):
        for lib in LIBRARY:
            if lib["name"] == old["name"]:
                continue
            trial = [dict(m) for m in materials]
            trial[idx] = {
                "name": lib["name"],
                "area": old["area"],
                "coeffs": {k: float(v) for k, v in lib["coeffs"].items()},
            }
            after_rt = band_rt60(volume, trial)
            after_eval, ok_count, violation = evaluate(after_rt, tmin, tmax)
            balance = _balance_score(after_rt, tmin, tmax)
            candidates.append({
                "rank_key": (-ok_count, violation, balance),
                "index": idx,
                "old_name": old["name"],
                "new_name": lib["name"],
                "new_coeffs": trial[idx]["coeffs"],
                "area": old["area"],
                "rt60": after_rt,
                "eval": after_eval,
                "ok_count": ok_count,
                "violation": violation,
                "materials": trial,
            })

    candidates.sort(key=lambda c: c["rank_key"])
    best = candidates[0] if candidates else None

    result = {
        "before": {
            "rt60": before_rt,
            "eval": before_eval,
            "ok_count": before_ok,
            "violation": before_violation,
            "absorption": before_abs,
        },
        "target": {"min": tmin, "max": tmax},
        "recommendation": None,
        "alternatives": [],
    }

    def explain(c: dict) -> list[str]:
        lines = [
            f"将「{c['old_name']}」（{c['area']:g} m²）替换为「{c['new_name']}」（面积不变）："
        ]
        after_abs = absorption_areas(c["materials"])
        for band in BANDS:
            b_rt = before_rt[band]
            a_rt = c["rt60"][band]
            mark = "✓ 达标" if c["eval"][band]["in_range"] else "✗ 未达标"
            b_txt = "∞" if b_rt is None else f"{b_rt:.2f}s"
            a_txt = "∞" if a_rt is None else f"{a_rt:.2f}s"
            lines.append(
                f"{band}Hz：吸声量 {before_abs[band]:.2f} → {after_abs[band]:.2f} m²，"
                f"RT60 {b_txt} → {a_txt}（{mark}）"
            )
        lines.append(
            f"达标频带 {before_ok}/{len(BANDS)} → {c['ok_count']}/{len(BANDS)}，"
            f"总违规量 {before_violation:.3f}s → {c['violation']:.3f}s"
        )
        return lines

    if best is not None:
        result["recommendation"] = {
            "old_name": best["old_name"],
            "new_name": best["new_name"],
            "new_coeffs": best["new_coeffs"],
            "area": best["area"],
            "index": best["index"],
            "rt60": best["rt60"],
            "eval": best["eval"],
            "ok_count": best["ok_count"],
            "violation": best["violation"],
            "improved": (best["ok_count"], -best["violation"]) > (before_ok, -before_violation),
            "explanation": explain(best),
            "materials": best["materials"],
        }
        result["alternatives"] = [
            {
                "old_name": c["old_name"],
                "new_name": c["new_name"],
                "ok_count": c["ok_count"],
                "violation": c["violation"],
            }
            for c in candidates[1:6]
        ]
    return result
