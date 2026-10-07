from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from engine.storage.db import get_session
from engine.storage.models import Exercise

router = APIRouter(prefix="/exercises", tags=["exercises"])


@router.post("", response_model=Exercise)
def create_exercise(exercise: Exercise, session: Session = Depends(get_session)):
    existing = session.exec(
        select(Exercise).where(Exercise.exercise_id == exercise.exercise_id)
    ).first()
    if existing:
        raise HTTPException(status_code=409, detail=f"exercise_id '{exercise.exercise_id}' already exists")
    exercise.id = None
    session.add(exercise)
    session.commit()
    session.refresh(exercise)
    return exercise


@router.get("", response_model=list[Exercise])
def list_exercises(session: Session = Depends(get_session)):
    return session.exec(select(Exercise)).all()


@router.get("/{exercise_id}", response_model=Exercise)
def get_exercise(exercise_id: str, session: Session = Depends(get_session)):
    exercise = session.exec(select(Exercise).where(Exercise.exercise_id == exercise_id)).first()
    if not exercise:
        raise HTTPException(status_code=404, detail=f"exercise_id '{exercise_id}' not found")
    return exercise
