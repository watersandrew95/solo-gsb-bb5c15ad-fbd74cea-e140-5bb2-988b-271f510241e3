# 混响配方实验台 🔊

一个房间声学小工具：录入房间体积与各表面材料的吸声系数（125 / 250 / 500 / 1000 / 2000 Hz 五个频带），按**赛宾公式**逐频带计算 RT60 并绘制频响曲线；设定目标混响区间后，系统用**可解释的约束搜索**推荐「一次材料替换」，让各频带尽量同时达标。实验可保存、回看与删除。

- 后端：Python + FastAPI + SQLite（标准库 `sqlite3`，无 ORM）
- 前端：原生 HTML / CSS / JS（Canvas 手绘曲线，零依赖）
- 部署：Docker Compose 一键启动

## 快速启动

```bash
docker compose up --build
```

启动后访问：**http://localhost:8000**

（API 文档：http://localhost:8000/docs ）

## 配置

| 配置项 | 默认值 | 说明 |
|---|---|---|
| 端口映射 | `8000:8000` | 在 `docker-compose.yml` 的 `ports` 中修改，如 `"8080:8000"` |
| `DB_PATH` | `/data/reverb.db` | SQLite 文件路径；容器内 `/data` 已挂载命名卷 `reverb-data`，删容器不丢数据 |

首次启动自动建表并内置 12 种常见建材的吸声系数（混凝土、玻璃、地毯、矿棉吸音板等）。

## 不使用 Docker 本地运行

```bash
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

## 使用流程

1. **创建房间**：填名称与体积 V (m³)。
2. **添加表面**：逐个录入表面（天花板、墙面、地面…）、面积与材料。
3. **查看曲线**：右侧面板实时显示 5 个频带的等效吸声量 A、RT60 与频响曲线。
4. **设定目标区间**：如 0.6 ~ 1.0 s，点击「推荐一次材料替换」。
5. **查看推荐**：系统给出最优替换与备选方案，逐频带解释吸声量与 RT60 的变化。
6. **保存实验**：命名后保存当前配置、目标区间、RT60 结果与推荐方案，可在左侧随时回看或删除。

## 计算说明

- 等效吸声量：`A(f) = Σ Sᵢ · αᵢ(f)`（m²）
- 混响时间（赛宾公式）：`RT60(f) = 0.161 · V / A(f)`
- 推荐引擎：枚举「每个表面 × 材料库中每种替代材料」的全部单步替换，按
  **达标频带数（多者优先）→ 区间外总偏差（小者优先）** 排序；
  每个候选都附带逐频带的前后对比，解释为什么推荐它。

## 主要 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/materials` | 材料库（含 5 频带吸声系数） |
| POST | `/api/rooms` | 创建房间 `{name, volume}` |
| GET | `/api/rooms/{id}` | 房间详情 + 各频带 RT60 |
| POST | `/api/rooms/{id}/surfaces` | 添加表面 `{name, area, material_id}` |
| PUT / DELETE | `/api/surfaces/{id}` | 修改 / 删除表面 |
| POST | `/api/rooms/{id}/recommend` | 推荐替换 `{target_min, target_max}` |
| POST | `/api/rooms/{id}/experiments` | 保存实验快照 |
| GET / DELETE | `/api/experiments[/{id}]` | 列出 / 查看 / 删除实验 |

## 项目结构

```
app/
├── main.py        # FastAPI 应用、SQLite 建表与 API 路由
├── acoustics.py   # 赛宾公式 RT60 计算 + 可解释约束搜索
└── static/        # 原生前端（index.html / style.css / app.js）
Dockerfile
docker-compose.yml
requirements.txt
```
