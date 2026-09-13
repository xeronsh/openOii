from fastapi import APIRouter

from app.api.v1.routes.assets import router as assets_router
from app.api.v1.routes.characters import router as characters_router
from app.api.v1.routes.config import router as config_router
from app.api.v1.routes.consistency import router as consistency_router
from app.api.v1.routes.export import router as export_router
from app.api.v1.routes.runs import router as runs_router
from app.api.v1.routes.projects import router as projects_router
from app.api.v1.routes.shots import router as shots_router
from app.api.v1.routes.skills import router as skills_router
from app.api.v1.routes.style_templates import router as style_templates_router
from app.api.v1.routes.text import router as text_router
from app.api.v1.routes.universes import router as universes_router
from app.api.v1.routes.versions import router as versions_router

api_router = APIRouter()
api_router.include_router(projects_router, prefix="/projects", tags=["projects"])
api_router.include_router(runs_router, tags=["runs"])
api_router.include_router(config_router, prefix="/config", tags=["config"])
api_router.include_router(characters_router, prefix="/characters", tags=["characters"])
api_router.include_router(shots_router, prefix="/shots", tags=["shots"])
api_router.include_router(assets_router, prefix="/assets", tags=["assets"])
api_router.include_router(style_templates_router, prefix="/style-templates", tags=["style-templates"])
api_router.include_router(text_router)
api_router.include_router(export_router, prefix="/projects", tags=["export"])
api_router.include_router(versions_router, tags=["versions"])
api_router.include_router(consistency_router, prefix="/projects", tags=["consistency"])
api_router.include_router(universes_router, prefix="/universes", tags=["universes"])
api_router.include_router(skills_router)
