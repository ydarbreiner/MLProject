FROM condaforge/mambaforge:latest

WORKDIR /app

# Install system dependencies for PostgreSQL
RUN apt-get update && apt-get install -y \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Install PDAL and Python packages via conda
RUN mamba install -c conda-forge \
    pdal \
    python-pdal \
    python=3.11 \
    fastapi \
    uvicorn \
    sqlalchemy \
    alembic \
    psycopg2 \
    pydantic \
    pydantic-settings \
    python-dotenv \
    laspy \
    numpy \
    aiofiles \
    python-multipart \
    celery \
    redis-py \
    shapely \
    proj \
    pyproj \
    pytorch \
    scikit-learn \
    scipy \
    tqdm

# Install copclib via pip (not available in conda)
RUN pip install copclib

# Copy application code
COPY . .

# Create directories for uploads and point clouds
RUN mkdir -p uploads pointclouds

# Expose port
EXPOSE 8000

# Run database migrations and start the server
CMD ["sh", "-c", "python run_migrations.py && uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload"]
