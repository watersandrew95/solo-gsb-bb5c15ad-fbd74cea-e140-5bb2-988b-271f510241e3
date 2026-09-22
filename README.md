# 🎛️ 混响配方实验台（Reverb Recipe Lab）

一个房间混响设计小工具：输入房间体积与各表面材料在 **125 / 250 / 500 / 1000 / 2000 Hz** 五个频带的吸声系数，系统按 **Sabine 公式** 分频带计算 RT60 并绘制频响曲线；设定目标混响区间后，系统通过**可解释的约束搜索**推荐一次材料替换，使各频带尽量同时达标。实验方案可保存、载入与删除。

## 功能

- **分频带 RT60 计算**：`RT60 = 0.161 · V / A`，`A = Σ(材料面积 × 该频带吸声系数)`
- **频响曲线**：Canvas 绘制 RT60-频率曲线，绿色阴影标注目标区间，达标/未达标分色显示
- **目标区间与推荐**：枚举「房间内每个材料 × 材料库候选」的单次替换，按
  ① 达标频带数 → ② 总违规量 → ③ 与区间中点的均衡度 排序，
  并逐频带给出「吸声量 / RT60 前后对比」的可读解释，可一键应用
- **实验管理**：保存、载入、删除（SQLite 持久化）
- **内置材料库**：混凝土、玻璃、地毯、吸音板等 12 种典型材料，可快速填充

## 一键启动（Docker Compose）

```bash
docker compose up --build
```

访问地址：**http://localhost:8000**

- 交互式 API 文档：http://localhost:8000/docs
- 停止：`docker compose down`（加 `-v` 可同时清除数据卷）

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `DB_PATH` | 容器内 `/data/reverb.db` | SQLite 数据库文件路径 |

- 端口映射在 `docker-compose.yml` 中修改（默认 `8000:8000`）。
- 实验数据保存在名为 `reverb_data` 的 Docker 卷中，容器重建不丢失。

## 本地开发（不用 Docker）

```bash
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

访问 http://localhost:8000 ，数据库默认写入 `./reverb.db`。

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/materials` | 预设材料库 |
| POST | `/api/calculate` | 分频带 RT60 计算与达标评估 |
| POST | `/api/recommend` | 约束搜索推荐一次材料替换（含解释） |
| GET / POST | `/api/experiments` | 实验列表 / 保存 |
| GET / DELETE | `/api/experiments/{id}` | 载入 / 删除实验 |

## 项目结构

```
app/
├── main.py          # FastAPI 入口与 API 路由
├── acoustics.py     # Sabine 公式 RT60 计算、达标评估
├── recommend.py     # 可解释约束搜索（单次材料替换）
├── library.py       # 预设材料吸声系数库
├── db.py            # SQLite 实验存取
└── static/          # 原生 HTML / CSS / JS 前端
Dockerfile
docker-compose.yml
requirements.txt
```

> 说明：Sabine 公式适用于扩散声场、吸声较均匀的房间；材料库系数为典型参考值，实际工程请以实测数据为准。
