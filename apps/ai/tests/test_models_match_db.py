"""The SQLAlchemy models match the migrated database (Prisma owns the DDL).

Reflects the ai schema and compares it with the models' metadata the way Alembic's
autogenerate does; any difference (a column, type, nullability, index or constraint)
fails, so a migration can't silently leave the models behind. Foreign keys into other
schemas exist only in the database and are skipped.
"""

import os
from typing import cast

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import create_engine

from app.db.models import Base

pytestmark = pytest.mark.integration


def _include(
    obj: object, name: str | None, type_: str, reflected: bool, compare_to: object
) -> bool:
    # Alembic hands over schema items untyped; getattr reads what each kind has.
    if type_ == "table":
        return cast(object, getattr(obj, "schema", None)) == "ai"
    if type_ == "foreign_key_constraint":
        referred = cast(object, getattr(obj, "referred_table", None))
        return cast(object, getattr(referred, "schema", None)) == "ai"
    return True


def test_models_match_the_migrated_database() -> None:
    url = os.environ["AI_DATABASE_URL"].replace("postgresql://", "postgresql+psycopg://", 1)
    engine = create_engine(url)
    with engine.connect() as connection:
        context = MigrationContext.configure(
            connection,
            opts={
                "include_schemas": True,
                "include_object": _include,
                "compare_type": True,
                "compare_server_default": True,
            },
        )
        # A list of differences, as tuples Alembic leaves untyped.
        differences = cast(list[object], compare_metadata(context, Base.metadata))
    engine.dispose()
    assert differences == [], "\n".join(str(d) for d in differences)
