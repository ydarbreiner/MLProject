from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from app.core.config import settings
from app.api.pointclouds import router as pointclouds_router
from app.api.analysis import router as analysis_router
from app.routers.classification_colors import router as classification_colors_router
import os

# Create FastAPI app
app = FastAPI(
    title="Point Cloud Viewer API",
    description="Backend API for Point Cloud Viewer application",
    version="1.0.0"
)

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include API routes
app.include_router(pointclouds_router, prefix=settings.api_prefix)
app.include_router(analysis_router, prefix=settings.api_prefix)
app.include_router(classification_colors_router)  # Already has /api prefix in router definition

# Serve static files (processed point clouds)
if os.path.exists(settings.pointcloud_output_dir):
    app.mount("/pointclouds", StaticFiles(directory=settings.pointcloud_output_dir), name="pointclouds")

# Serve uploads directory (for training graphs, etc.)
if os.path.exists(settings.upload_dir):
    app.mount("/uploads", StaticFiles(directory=settings.upload_dir), name="uploads")

@app.get("/")
def read_root():
    return {"message": "Point Cloud Viewer API", "version": "1.0.0"}

@app.get(f"{settings.api_prefix}/system/status")
def get_system_status():
    return {
        "status": "healthy",
        "upload_dir": settings.upload_dir,
        "pointcloud_dir": settings.pointcloud_output_dir,
        "max_file_size": settings.max_file_size
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
