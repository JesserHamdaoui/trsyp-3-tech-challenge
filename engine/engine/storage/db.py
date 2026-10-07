"""
Postgres engine + session helper. All DB access goes through get_session()
so the URL (engine.config.settings.database_url) is the only place that
needs to change to point at a different Postgres instance.
"""

from sqlmodel import SQLModel, Session, create_engine

from engine.config import settings

engine = create_engine(settings.database_url, echo=False)


def init_db():
    SQLModel.metadata.create_all(engine)


def get_session():
    with Session(engine) as session:
        yield session
