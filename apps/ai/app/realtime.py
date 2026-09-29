"""Live-update nudges, in the same format the TypeScript services publish (see
packages/nest-common realtime): Redis pub/sub on `realtime:<channel>`, with a message
from the shared contract (generated into app/contracts)."""

from uuid import UUID

from redis.asyncio import Redis

from app.contracts.realtime_message import RealtimeMessage

PREFIX = "realtime:"


async def publish_to_org(redis: Redis, org_id: UUID, message: dict[str, str]) -> None:
    validated = RealtimeMessage.model_validate(message)
    # redis-py types publish's extra keyword arguments as unknown.
    await redis.publish(f"{PREFIX}org:{org_id}", validated.model_dump_json())  # pyright: ignore[reportUnknownMemberType]
