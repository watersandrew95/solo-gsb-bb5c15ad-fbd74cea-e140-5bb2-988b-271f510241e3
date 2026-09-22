"""混响配方实验台 —— FastAPI 后端。"""

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from .acoustics import BANDS, absorption_areas, band_rt60, evaluate
from .db import (create_experiment, delete_experiment, get_experiment,
                 init_db, list_experiments)
from .library import LIBRARY
from .recommend import recommend

STATIC_DIR = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="混响配方实验台", lifespan=lifespan)


# ---------- 数据模型 ----------

class Material(BaseModel):
    name: str = Field(min_length=1, max_length=50)
    area: float = Field(gt=0, le=1_000_000, description="铺设面积 m²")
    coeffs: dict[str, float]

    @field_validator("coeffs")
    @classmethod
    def check_coeffs(cls, v: dict[str, float]) -> dict[str, float]:
        cleaned = {}
        for band in BANDS:
            key = str(band)
            if key not in v:
                raise ValueError(f"缺少 {band}Hz 的吸声系数")
            c = float(v[key])
            if not 0.0 <= c <= 1.0:
                raise ValueError(f"{band}Hz 吸声系数须在 0~1 之间")
            cleaned[key] = c
        return cleaned


class RoomConfig(BaseModel):
    volume: float = Field(gt=0, le=10_000_000, description="房间体积 m³")
    materials: list[Material] = Field(min_length=1)
    target_min: float = Field(default=0.4, ge=0, description="目标 RT60 下限 s")
    target_max: float = Field(default=0.8, gt=0, description="目标 RT60 上限 s")

    @field_validator("target_max")
    @classmethod
    def check_range(cls, v: float, info) -> float:
        tmin = info.data.get("target_min")
        if tmin is not None and v < tmin:
            raise ValueError("目标上限不能小于下限")
        return v


class ExperimentSave(RoomConfig):
    name: str = Field(min_length=1, max_length=80)


# ---------- API ----------

@app.get("/api/materials")
def api_materials():
    """预设材料库（推荐候选 + 前端快速填充）。"""
    return {"bands": BANDS, "library": LIBRARY}


@app.post("/api/calculate")
def api_calculate(config: RoomConfig):
    """按频带计算 RT60 并对照目标区间评估。"""
    materials = [m.model_dump() for m in config.materials]
    rt60 = band_rt60(config.volume, materials)
    per_band, ok_count, violation = evaluate(rt60, config.target_min, config.target_max)
    return {
        "bands": BANDS,
        "absorption": absorption_areas(materials),
        "rt60": rt60,
        "eval": per_band,
        "ok_count": ok_count,
        "violation": violation,
        "target": {"min": config.target_min, "max": config.target_max},
    }


@app.post("/api/recommend")
def api_recommend(config: RoomConfig):
    """约束搜索：推荐一次材料替换，使各频带尽量同时达标。"""
    materials = [m.model_dump() for m in config.materials]
    return recommend(config.volume, materials, config.target_min, config.target_max)


@app.get("/api/experiments")
def api_list_experiments():
    return {"experiments": list_experiments()}


@app.post("/api/experiments", status_code=201)
def api_save_experiment(exp: ExperimentSave):
    config = exp.model_dump()
    name = config.pop("name")
    return create_experiment(name, config)


@app.get("/api/experiments/{exp_id}")
def api_get_experiment(exp_id: int):
    exp = get_experiment(exp_id)
    if exp is None:
        raise HTTPException(status_code=404, detail="实验不存在")
    return exp


@app.delete("/api/experiments/{exp_id}", status_code=204)
def api_delete_experiment(exp_id: int):
    if not delete_experiment(exp_id):
        raise HTTPException(status_code=404, detail="实验不存在")
    return None


# ---------- 前端静态页 ----------

@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
