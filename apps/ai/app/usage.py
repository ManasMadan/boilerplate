"""Token budgets and the usage ledger (ai.usage), shared by every feature that calls a
model: a workspace's monthly allowance is checked before the work, and what the work
used is recorded after it."""

import datetime
from uuid import UUID

from sqlalchemy import func, select

from app.db.models import AiUsage
from app.db.session import tenant


async def used_this_month(org_id: UUID) -> int:
    month = datetime.datetime.now(datetime.UTC).replace(
        day=1, hour=0, minute=0, second=0, microsecond=0
    )
    async with tenant(org_id) as session:
        used = await session.scalar(
            select(func.coalesce(func.sum(AiUsage.input_tokens + AiUsage.output_tokens), 0)).where(
                AiUsage.org_id == org_id, AiUsage.created_at >= month
            )
        )
    return int(used or 0)


async def record(
    org_id: UUID,
    user_id: UUID | None,
    feature: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
) -> None:
    if not input_tokens and not output_tokens:
        return
    async with tenant(org_id) as session:
        session.add(
            AiUsage(
                org_id=org_id,
                user_id=user_id,
                feature=feature,
                model=model,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
            )
        )
