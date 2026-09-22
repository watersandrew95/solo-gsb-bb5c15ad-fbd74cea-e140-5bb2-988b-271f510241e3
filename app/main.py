"""混响配方实验台 —— FastAPI 后端。

数据模型:
  materials   材料库（启动时内置常见建材，含 5 个频带吸声系数）
  rooms       房间（名称 + 体积）
  surfaces    房间内的表面（名称 + 面积 + 材料）
  experiments 保存的实验快照（目标区间 + RT60 结果 + 推荐方案）
"""
import json
import os
import sqlite3
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.acoustics import BANDS, compute_rt60, recommend_replacement

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DB_PATH = os.environ.get("DB_PATH", str(BASE_DIR.parent / "reverb.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS materials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT DEFAULT '',
    a125 REAL NOT NULL, a250 REAL NOT NULL, a500 REAL NOT NULL,
    a1000 REAL NOT NULL, a2000 REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    volume REAL NOT NULL CHECK (volume > 0),
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS surfaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    area REAL NOT NULL CHECK (area > 0),
    material_id INTEGER NOT NULL REFERENCES materials(id)
);
CREATE TABLE IF NOT EXISTS experiments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    target_min REAL NOT NULL,
    target_max REAL NOT NULL,
    rt60_json TEXT NOT NULL,
    recommendation_json TEXT,
    created_at TEXT NOT NULL
);
"""

# (名称, 说明, α125, α250, α500, α1000, α2000) —— 常见建材典型值
SEED_MATERIALS = [
    ("清水混凝土墙", "未粉刷混凝土，强反射", 0.01, 0.02, 0.02, 0.03, 0.04),
    ("砖墙抹灰", "抹灰砖墙", 0.02, 0.02, 0.03, 0.04, 0.05),
    ("平板玻璃 6mm", "窗户玻璃", 0.10, 0.08, 0.05, 0.04, 0.03),
    ("木地板", "龙骨上铺木地板", 0.15, 0.11, 0.10, 0.07, 0.06),
    ("水磨石地面", "硬质地面", 0.01, 0.01, 0.02, 0.02, 0.03),
    ("厚地毯(带衬垫)", "铺设于硬地面", 0.05, 0.10, 0.25, 0.40, 0.50),
    ("丝绒窗帘(打褶)", "打褶悬挂", 0.07, 0.31, 0.49, 0.75, 0.70),
    ("矿棉吸音板 25mm", "吊顶/墙面安装", 0.10, 0.40, 0.80, 0.95, 0.90),
    ("聚酯纤维吸音板", "墙面装饰吸音", 0.15, 0.35, 0.65, 0.85, 0.90),
    ("穿孔石膏板(空腔)", "板后留空腔", 0.30, 0.50, 0.60, 0.55, 0.45),
    ("软包座椅/沙发", "织物软包家具", 0.30, 0.40, 0.50, 0.60, 0.60),
    ("木丝吸音板", "水泥木丝板", 0.10, 0.25, 0.55, 0.70, 0.75),
]


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    with get_conn() as conn:
        conn.executescript(SCHEMA)
        count = conn.execute("SELECT COUNT(*) AS c FROM materials").fetchone()["c"]
        if count == 0:
            conn.executemany(
                "INSERT INTO materials (name, description, a125, a250, a500, a1000, a2000)"
                " VALUES (?,?,?,?,?,?,?)",
                SEED_MATERIALS,
            )


@asynccontextmanager
async def lifespan(app):
    init_db()
    yield


app = FastAPI(title="混响配方实验台", lifespan=lifespan)


# ---------- 数据装配 ----------

def row_to_material(r):
    return {
        "id": r["id"], "name": r["name"], "description": r["description"],
        "coeffs": [r["a125"], r["a250"], r["a500"], r["a1000"], r["a2000"]],
    }


def load_materials(conn):
    return [row_to_material(r) for r in conn.execute("SELECT * FROM materials ORDER BY id")]


def load_room(conn, room_id):
    room = conn.execute("SELECT * FROM rooms WHERE id=?", (room_id,)).fetchone()
    if not room:
        raise HTTPException(404, "房间不存在")
    surfaces = []
    for r in conn.execute(
        """SELECT s.*, m.name AS material_name,
                  m.a125, m.a250, m.a500, m.a1000, m.a2000
           FROM surfaces s JOIN materials m ON m.id = s.material_id
           WHERE s.room_id=? ORDER BY s.id""",
        (room_id,),
    ):
        surfaces.append({
            "id": r["id"], "name": r["name"], "area": r["area"],
            "material_id": r["material_id"], "material_name": r["material_name"],
            "coeffs": [r["a125"], r["a250"], r["a500"], r["a1000"], r["a2000"]],
        })
    return room, surfaces


def room_payload(conn, room_id):
    room, surfaces = load_room(conn, room_id)
    return {
        "id": room["id"], "name": room["name"], "volume": room["volume"],
        "created_at": room["created_at"],
        "surfaces": [{k: v for k, v in s.items() if k != "coeffs"} for s in surfaces],
        "rt60": compute_rt60(room["volume"], surfaces),
    }


# ---------- 请求模型 ----------

class RoomIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    volume: float = Field(gt=0, le=1_000_000)


class SurfaceIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    area: float = Field(gt=0, le=1_000_000)
    material_id: int


class TargetIn(BaseModel):
    target_min: float = Field(ge=0.05, le=20)
    target_max: float = Field(ge=0.05, le=20)


class ExperimentIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    target_min: float = Field(ge=0.05, le=20)
    target_max: float = Field(ge=0.05, le=20)


def check_target(t):
    if t.target_min > t.target_max:
        raise HTTPException(400, "目标下限不能大于上限")


# ---------- 页面 ----------

@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html")


# ---------- 材料库 ----------

@app.get("/api/materials")
def api_materials():
    with get_conn() as conn:
        return {"bands": BANDS, "materials": load_materials(conn)}


# ---------- 房间 ----------

@app.get("/api/rooms")
def api_rooms():
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM rooms ORDER BY id DESC").fetchall()
        return [dict(r) for r in rows]


@app.post("/api/rooms", status_code=201)
def api_create_room(body: RoomIn):
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO rooms (name, volume, created_at) VALUES (?,?,?)",
            (body.name, body.volume, datetime.now().isoformat(timespec="seconds")),
        )
        return room_payload(conn, cur.lastrowid)


@app.get("/api/rooms/{room_id}")
def api_room(room_id: int):
    with get_conn() as conn:
        return room_payload(conn, room_id)


@app.put("/api/rooms/{room_id}")
def api_update_room(room_id: int, body: RoomIn):
    with get_conn() as conn:
        load_room(conn, room_id)
        conn.execute("UPDATE rooms SET name=?, volume=? WHERE id=?",
                     (body.name, body.volume, room_id))
        return room_payload(conn, room_id)


@app.delete("/api/rooms/{room_id}", status_code=204)
def api_delete_room(room_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM rooms WHERE id=?", (room_id,))


# ---------- 表面 ----------

@app.post("/api/rooms/{room_id}/surfaces", status_code=201)
def api_add_surface(room_id: int, body: SurfaceIn):
    with get_conn() as conn:
        load_room(conn, room_id)
        if not conn.execute("SELECT 1 FROM materials WHERE id=?",
                            (body.material_id,)).fetchone():
            raise HTTPException(400, "材料不存在")
        conn.execute(
            "INSERT INTO surfaces (room_id, name, area, material_id) VALUES (?,?,?,?)",
            (room_id, body.name, body.area, body.material_id),
        )
        return room_payload(conn, room_id)


@app.put("/api/surfaces/{surface_id}")
def api_update_surface(surface_id: int, body: SurfaceIn):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM surfaces WHERE id=?", (surface_id,)).fetchone()
        if not row:
            raise HTTPException(404, "表面不存在")
        conn.execute(
            "UPDATE surfaces SET name=?, area=?, material_id=? WHERE id=?",
            (body.name, body.area, body.material_id, surface_id),
        )
        return room_payload(conn, row["room_id"])


@app.delete("/api/surfaces/{surface_id}")
def api_delete_surface(surface_id: int):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM surfaces WHERE id=?", (surface_id,)).fetchone()
        if not row:
            raise HTTPException(404, "表面不存在")
        conn.execute("DELETE FROM surfaces WHERE id=?", (surface_id,))
        return room_payload(conn, row["room_id"])


# ---------- 推荐 ----------

@app.post("/api/rooms/{room_id}/recommend")
def api_recommend(room_id: int, body: TargetIn):
    check_target(body)
    with get_conn() as conn:
        room, surfaces = load_room(conn, room_id)
        materials = load_materials(conn)
        return recommend_replacement(
            room["volume"], surfaces, materials, body.target_min, body.target_max
        )


# ---------- 实验保存/删除 ----------

@app.post("/api/rooms/{room_id}/experiments", status_code=201)
def api_save_experiment(room_id: int, body: ExperimentIn):
    check_target(body)
    with get_conn() as conn:
        room, surfaces = load_room(conn, room_id)
        if not surfaces:
            raise HTTPException(400, "请先为房间添加表面再保存实验")
        materials = load_materials(conn)
        rt60 = compute_rt60(room["volume"], surfaces)
        rec = recommend_replacement(
            room["volume"], surfaces, materials, body.target_min, body.target_max
        )
        snapshot = {
            "room_name": room["name"], "volume": room["volume"],
            "surfaces": [{k: v for k, v in s.items() if k != "coeffs"} for s in surfaces],
            "rt60": rt60,
        }
        cur = conn.execute(
            "INSERT INTO experiments"
            " (room_id, name, target_min, target_max, rt60_json, recommendation_json, created_at)"
            " VALUES (?,?,?,?,?,?,?)",
            (room_id, body.name, body.target_min, body.target_max,
             json.dumps(snapshot, ensure_ascii=False),
             json.dumps(rec, ensure_ascii=False),
             datetime.now().isoformat(timespec="seconds")),
        )
        return {"id": cur.lastrowid}


@app.get("/api/experiments")
def api_experiments():
    with get_conn() as conn:
        out = []
        for r in conn.execute(
            "SELECT e.*, r.name AS room_name FROM experiments e"
            " LEFT JOIN rooms r ON r.id = e.room_id ORDER BY e.id DESC"
        ):
            out.append({
                "id": r["id"], "name": r["name"], "room_name": r["room_name"],
                "target_min": r["target_min"], "target_max": r["target_max"],
                "created_at": r["created_at"],
            })
        return out


@app.get("/api/experiments/{exp_id}")
def api_experiment(exp_id: int):
    with get_conn() as conn:
        r = conn.execute("SELECT * FROM experiments WHERE id=?", (exp_id,)).fetchone()
        if not r:
            raise HTTPException(404, "实验不存在")
        return {
            "id": r["id"], "name": r["name"],
            "target_min": r["target_min"], "target_max": r["target_max"],
            "created_at": r["created_at"],
            "snapshot": json.loads(r["rt60_json"]),
            "recommendation": json.loads(r["recommendation_json"])
            if r["recommendation_json"] else None,
        }


@app.delete("/api/experiments/{exp_id}", status_code=204)
def api_delete_experiment(exp_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM experiments WHERE id=?", (exp_id,))


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
