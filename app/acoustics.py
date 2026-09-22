"""声学计算核心。

- RT60 按频带使用赛宾（Sabine）公式:  T = 0.161 * V / A
  其中 A 为该频带等效吸声量 A = Σ S_i * α_i  (单位 m²)。
- 推荐引擎: 可解释的约束搜索 —— 枚举「把某一个表面的材料换成材料库中另一种」
  的全部单步替换，按 (达标频带数最多, 总偏差最小) 排序，并生成中文解释。
"""

BANDS = [125, 250, 500, 1000, 2000]  # 频带中心频率 Hz
SABINE_K = 0.161                     # 赛宾常数（SI 单位制）
RT60_DISPLAY_CAP = 20.0              # 展示/评分上限（秒）


def equivalent_absorption(surfaces, band_idx):
    """某频带的等效吸声量 A = Σ 面积_i × 吸声系数_i (m²)。"""
    return sum(s["area"] * s["coeffs"][band_idx] for s in surfaces)


def compute_rt60(volume, surfaces):
    """按频带计算 RT60。

    surfaces: [{"id", "name", "area", "material_id", "coeffs": [a125..a2000]}, ...]
    返回 {"volume": V, "bands": {"125": {"absorption": A, "rt60": T}, ...}}
    A <= 0 时 rt60 为 None（前端显示为 ∞）。
    """
    bands = {}
    for i, band in enumerate(BANDS):
        A = equivalent_absorption(surfaces, i)
        rt60 = SABINE_K * volume / A if A > 1e-9 else None
        bands[str(band)] = {
            "absorption": round(A, 3),
            "rt60": round(rt60, 3) if rt60 is not None else None,
        }
    return {"volume": volume, "bands": bands}


def _score(bands, tmin, tmax):
    """评分: (达标频带数, 总偏差秒数)。达标数越大越好，偏差越小越好。"""
    ok, dev = 0, 0.0
    for band in BANDS:
        rt = bands[str(band)]["rt60"]
        if rt is None:
            dev += RT60_DISPLAY_CAP
            continue
        if tmin <= rt <= tmax:
            ok += 1
        elif rt < tmin:
            dev += tmin - rt
        else:
            dev += rt - tmax
    return ok, round(dev, 3)


def _band_details(before, after, tmin, tmax):
    """逐频带的前后对比，用于生成可解释说明。"""
    details = []
    for band in BANDS:
        b = str(band)
        a0, a1 = before["bands"][b]["absorption"], after["bands"][b]["absorption"]
        r0, r1 = before["bands"][b]["rt60"], after["bands"][b]["rt60"]

        def status(rt):
            if rt is None:
                return "bad"
            return "ok" if tmin <= rt <= tmax else "bad"

        details.append({
            "band": band,
            "absorption_before": a0,
            "absorption_after": a1,
            "rt60_before": r0,
            "rt60_after": r1,
            "status_before": status(r0),
            "status_after": status(r1),
            "improved": status(r1) == "ok" and status(r0) != "ok",
            "worsened": status(r1) != "ok" and status(r0) == "ok",
        })
    return details


def _explain(surface_name, old_name, new_name, details, ok_before, ok_after):
    changed = [d for d in details if d["improved"]]
    worsened = [d for d in details if d["worsened"]]
    parts = [
        f"将「{surface_name}」的材料由 {old_name} 替换为 {new_name}，"
        f"达标频带 {ok_before}/5 → {ok_after}/5。"
    ]
    if changed:
        seg = "；".join(
            f"{d['band']}Hz 吸声量 {d['absorption_before']:.2f}→{d['absorption_after']:.2f} m²，"
            f"RT60 {d['rt60_before']}s→{d['rt60_after']}s，进入目标区间"
            for d in changed
        )
        parts.append("改善: " + seg + "。")
    if worsened:
        seg = "；".join(f"{d['band']}Hz 跌出目标区间" for d in worsened)
        parts.append("注意: " + seg + "。")
    if not changed and not worsened:
        parts.append("各频带达标状态不变，但总偏差最小。")
    return "".join(parts)


def _candidate_payload(volume, surface, new_material, before, tmin, tmax, ok_before):
    trial = []
    for s in before["_surfaces"]:
        if s["id"] == surface["id"]:
            s = dict(s)
            s["material_id"] = new_material["id"]
            s["coeffs"] = new_material["coeffs"]
        trial.append(s)
    after = compute_rt60(volume, trial)
    ok_after, dev_after = _score(after["bands"], tmin, tmax)
    details = _band_details(before, after, tmin, tmax)
    return {
        "surface_id": surface["id"],
        "surface_name": surface["name"],
        "old_material": surface["material_name"],
        "new_material": new_material["name"],
        "new_material_id": new_material["id"],
        "ok_after": ok_after,
        "deviation_after": dev_after,
        "rt60_after": {b: after["bands"][b]["rt60"] for b in after["bands"]},
        "band_details": details,
        "explanation": _explain(
            surface["name"], surface["material_name"], new_material["name"],
            details, ok_before, ok_after,
        ),
    }


def recommend_replacement(volume, surfaces, materials, tmin, tmax, top_n=5):
    """搜索最优的一次材料替换。

    返回 {"target", "before": {...}, "already_ok": bool,
          "best": {...}|None, "alternatives": [...]}
    """
    if not surfaces:
        return {"error": "房间还没有任何表面，请先添加表面。"}

    before = compute_rt60(volume, surfaces)
    before["_surfaces"] = surfaces  # 内部使用，返回前删除
    ok_before, dev_before = _score(before["bands"], tmin, tmax)

    candidates = []
    for s in surfaces:
        for m in materials:
            if m["id"] == s["material_id"]:
                continue
            candidates.append(
                _candidate_payload(volume, s, m, before, tmin, tmax, ok_before)
            )

    # 排序: 达标频带数降序 → 总偏差升序 → 替换后最大单带偏差升序（隐含在 deviation 中）
    candidates.sort(key=lambda c: (-c["ok_after"], c["deviation_after"]))

    result = {
        "target": {"min": tmin, "max": tmax},
        "before": {
            "ok": ok_before,
            "deviation": dev_before,
            "rt60": {b: before["bands"][b]["rt60"] for b in before["bands"]},
        },
        "already_ok": ok_before == len(BANDS),
        "best": candidates[0] if candidates else None,
        "alternatives": candidates[1:top_n],
    }
    return result
