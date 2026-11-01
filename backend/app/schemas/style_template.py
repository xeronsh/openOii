from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

from app.db.utils import UtcDatetime


class StyleTemplateRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    slug: str
    category: str
    description: Optional[str] = None
    style_prompt: str
    color_palette: list[str] = Field(default_factory=list)
    negative_prompt: Optional[str] = None
    preview_image_url: Optional[str] = None
    sort_order: int = 0
    is_active: bool = True
    created_at: UtcDatetime
    updated_at: UtcDatetime


class StyleTemplateListRead(BaseModel):
    items: list[StyleTemplateRead]
    total: int


class StyleTemplateCreate(BaseModel):
    name: str = Field(min_length=1)
    slug: str = Field(min_length=1, pattern=r"^[a-z0-9][a-z0-9\-]*[a-z0-9]$")
    description: Optional[str] = None
    style_prompt: str = Field(min_length=1)
    color_palette: list[str] = Field(default_factory=list)
    negative_prompt: Optional[str] = None
    preview_image_url: Optional[str] = None


class StyleTemplateUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1)
    description: Optional[str] = None
    style_prompt: Optional[str] = Field(default=None, min_length=1)
    color_palette: Optional[list[str]] = None
    negative_prompt: Optional[str] = None
    preview_image_url: Optional[str] = None
