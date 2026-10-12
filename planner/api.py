"""HTTP API для Mini App + раздача статики."""
import re
from datetime import date
from pathlib import Path

from aiogram.utils.web_app import safe_parse_webapp_init_data
from aiohttp import web

from .config import Config
from .db import Database
from .timeutil import local_now, safe_zone

WEBAPP_DIR = Path(__file__).resolve().parent.parent / "webapp"
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")

DB_KEY = web.AppKey("db", Database)
CFG_KEY = web.AppKey("cfg", Config)


@web.middleware
async def auth_middleware(request: web.Request, handler):
    if not request.path.startswith("/api/"):
        return await handler(request)
    cfg = request.app[CFG_KEY]
    init_data = request.headers.get("X-Telegram-Init-Data", "")
    user_id = first_name = None
    if init_data:
        try:
            data = safe_parse_webapp_init_data(cfg.bot_token, init_data)
            user_id, first_name = data.user.id, data.user.first_name
        except ValueError:
            raise web.HTTPUnauthorized(text="bad initData")
    elif cfg.dev_user_id:
        user_id, first_name = cfg.dev_user_id, "Dev"
    else:
        raise web.HTTPUnauthorized(text="open via Telegram")

    tz = request.headers.get("X-Timezone") or None
    if tz and safe_zone(tz, "UTC").key != tz:
        tz = None
    db = request.app[DB_KEY]
    await db.upsert_user(user_id, first_name=first_name, tz=tz)
    request["user_id"] = user_id
    return await handler(request)


def _bad(msg: str) -> web.HTTPBadRequest:
    return web.HTTPBadRequest(text=msg)


def _valid_date(v) -> str:
    try:
        return date.fromisoformat(str(v)).isoformat()
    except ValueError:
        raise _bad("bad date")


def _clean(payload: dict, *, partial: bool) -> dict:
    out: dict = {}
    if "title" in payload or not partial:
        title = str(payload.get("title", "")).strip()
        if not title:
            raise _bad("title required")
        out["title"] = title[:200]
    if "date" in payload or not partial:
        out["date"] = _valid_date(payload.get("date"))
    if "time" in payload:
        t = payload["time"] or None
        if t is not None and not TIME_RE.match(str(t)):
            raise _bad("bad time")
        out["time"] = t
    if "note" in payload:
        out["note"] = str(payload["note"] or "")[:1000]
    if "done" in payload and partial:
        out["done"] = bool(payload["done"])
    return out


async def _json(request: web.Request) -> dict:
    try:
        data = await request.json()
    except Exception:
        raise _bad("bad json")
    if not isinstance(data, dict):
        raise _bad("bad json")
    return data


routes = web.RouteTableDef()


@routes.get("/api/me")
async def me(request: web.Request):
    db, cfg = request.app[DB_KEY], request.app[CFG_KEY]
    user = await db.get_user(request["user_id"])
    now = local_now(user["tz"], cfg.default_tz)
    return web.json_response({
        "today": now.date().isoformat(), "tz": now.tzinfo.key, "first_name": user["first_name"] or "",
    })


@routes.get("/api/tasks")
async def list_tasks(request: web.Request):
    db = request.app[DB_KEY]
    d_from = _valid_date(request.query.get("from"))
    d_to = _valid_date(request.query.get("to", d_from))
    return web.json_response(await db.tasks_between(request["user_id"], d_from, d_to))


@routes.get("/api/overdue")
async def overdue(request: web.Request):
    db = request.app[DB_KEY]
    today = _valid_date(request.query.get("today"))
    return web.json_response(await db.overdue(request["user_id"], today))


@routes.post("/api/tasks")
async def create_task(request: web.Request):
    db = request.app[DB_KEY]
    data = _clean(await _json(request), partial=False)
    task = await db.create_task(request["user_id"], **data)
    return web.json_response(task, status=201)


@routes.patch("/api/tasks/{id:\\d+}")
async def update_task(request: web.Request):
    db = request.app[DB_KEY]
    data = _clean(await _json(request), partial=True)
    task = await db.update_task(request["user_id"], int(request.match_info["id"]), **data)
    if not task:
        raise web.HTTPNotFound()
    return web.json_response(task)


@routes.delete("/api/tasks/{id:\\d+}")
async def delete_task(request: web.Request):
    db = request.app[DB_KEY]
    if not await db.delete_task(request["user_id"], int(request.match_info["id"])):
        raise web.HTTPNotFound()
    return web.json_response({"ok": True})


@routes.get("/")
async def index(request: web.Request):
    return web.FileResponse(WEBAPP_DIR / "index.html")


def build_app(db: Database, cfg: Config) -> web.Application:
    app = web.Application(middlewares=[auth_middleware])
    app[DB_KEY] = db
    app[CFG_KEY] = cfg
    app.add_routes(routes)
    app.router.add_static("/static/", WEBAPP_DIR)
    return app
