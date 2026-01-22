
from fastapi import FastAPI, HTTPException, Depends, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, validator
from typing import Optional
from datetime import datetime, timedelta
import sqlite3
import json
import os
from geopy.distance import geodesic
from dotenv import load_dotenv
import logging

# Load environment variables
load_dotenv()

# Import your modules
from src.sms_sender import send_sms
from src.map import get_nearby_places

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Rate limiting
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

limiter = Limiter(key_func=get_remote_address)
app = FastAPI(title="SafeReach API", version="1.0.0")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Get environment
ENVIRONMENT = os.getenv("ENVIRONMENT", "development")
API_KEYS = set(filter(None, os.getenv("API_KEYS", "").split(",")))

# CORS Configuration - UPDATED FOR RENDER
allowed_origins = [
    "https://safereach-api.onrender.com",  # Replace with your Render URL
    "capacitor://localhost",
    "ionic://localhost"
]

# Allow localhost only in development
if ENVIRONMENT == "development":
    allowed_origins.extend([
        "http://localhost:3000",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        "http://192.168.1.9:8000"  # Your local IP
    ])
else:
    # In production, allow all origins (or specify your domains)
    allowed_origins = ["*"]  # Change this to your actual domains in production

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "X-API-Key"],
)

# Mount static files
FRONTEND_DIR = os.path.join(os.path.dirname(__file__), 'frontend')
if os.path.exists(FRONTEND_DIR):
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")
    app.mount("/frontend", StaticFiles(directory=FRONTEND_DIR), name="frontend")
    logger.info(f"Frontend directory mounted: {FRONTEND_DIR}")

# Database setup with persistent storage on Render
DB_PATH = os.path.join(os.path.dirname(__file__), 'locations.db')

def init_db():
    """Initialize SQLite database"""
    try:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        
        # Locations table
        c.execute('''
            CREATE TABLE IF NOT EXISTS locations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                latitude REAL NOT NULL,
                longitude REAL NOT NULL,
                accuracy REAL,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        
        # Create indexes for performance
        c.execute('''
            CREATE INDEX IF NOT EXISTS idx_locations_user_id 
            ON locations(user_id)
        ''')
        c.execute('''
            CREATE INDEX IF NOT EXISTS idx_locations_timestamp 
            ON locations(timestamp DESC)
        ''')
        
        # User trips table
        c.execute('''
            CREATE TABLE IF NOT EXISTS user_trips (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                destination_lat REAL NOT NULL,
                destination_lng REAL NOT NULL,
                geofence_radius REAL NOT NULL,
                contacts TEXT,
                message_sent BOOLEAN DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                completed_at DATETIME
            )
        ''')
        
        # Create index for active trips
        c.execute('''
            CREATE INDEX IF NOT EXISTS idx_trips_user_active 
            ON user_trips(user_id, message_sent)
        ''')
        
        conn.commit()
        conn.close()
        logger.info(f"Database initialized successfully at {DB_PATH}")
    except Exception as e:
        logger.error(f"Database initialization failed: {e}")
        raise

# Initialize database on startup
init_db()

# Pydantic Models (same as before)
class Loc(BaseModel):
    lat: Optional[float] = Field(None, ge=-90, le=90)
    lng: Optional[float] = Field(None, ge=-180, le=180)
    latitude: Optional[float] = Field(None, ge=-90, le=90)
    longitude: Optional[float] = Field(None, ge=-180, le=180)
    user_id: str = Field(..., min_length=1, max_length=100)
    accuracy: Optional[float] = Field(None, ge=0)
    timestamp: Optional[str] = None
    
    @validator('user_id')
    def sanitize_user_id(cls, v):
        return v.replace("'", "").replace('"', "").replace(";", "").strip()
    
    def get_lat(self):
        return self.latitude if self.latitude is not None else self.lat
    
    def get_lng(self):
        return self.longitude if self.longitude is not None else self.lng

class Destination(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=100)
    destination_lat: float = Field(..., ge=-90, le=90)
    destination_lng: float = Field(..., ge=-180, le=180)
    geofence_radius: float = Field(500, ge=50, le=5000)
    contacts: list = []
    
    @validator('user_id')
    def sanitize_user_id(cls, v):
        return v.replace("'", "").replace('"', "").replace(";", "").strip()

class NearbyPlacesRequest(BaseModel):
    latitude: float = Field(..., ge=-90, le=90)
    longitude: float = Field(..., ge=-180, le=180)
    radius: int = Field(1000, ge=100, le=50000)
    place_type: str = Field("restaurant", min_length=1, max_length=50)

class SendMessageRequest(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=100)
    message: str = Field(..., min_length=1, max_length=1000)
    recipient_numbers: list
    
    @validator('user_id')
    def sanitize_user_id(cls, v):
        return v.replace("'", "").replace('"', "").replace(";", "").strip()

class ResetTripRequest(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=100)
    
    @validator('user_id')
    def sanitize_user_id(cls, v):
        return v.replace("'", "").replace('"', "").replace(";", "").strip()

# Health Check Endpoint
@app.get("/health")
async def health_check():
    """Health check endpoint for Render monitoring"""
    try:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute('SELECT 1')
        conn.close()
        
        return {
            "status": "healthy",
            "timestamp": datetime.utcnow().isoformat(),
            "environment": ENVIRONMENT,
            "checks": {
                "database": "ok"
            }
        }
    except Exception as e:
        logger.error(f"Health check failed: {e}")
        return JSONResponse(
            status_code=503,
            content={
                "status": "unhealthy",
                "error": str(e)
            }
        )

# Root endpoint
@app.get("/", response_class=FileResponse)
def home():
    frontend_path = os.path.join(FRONTEND_DIR, 'index.html')
    if os.path.exists(frontend_path):
        return frontend_path
    else:
        return HTMLResponse("""
        <!DOCTYPE html>
        <html>
        <head><title>SafeReach API</title></head>
        <body style="font-family: Arial; max-width: 600px; margin: 50px auto; padding: 20px;">
            <h1>🚗 SafeReach API</h1>
            <p>API is running successfully!</p>
            <ul>
                <li><a href="/docs">📚 API Documentation</a></li>
                <li><a href="/health">🏥 Health Check</a></li>
            </ul>
            <p><em>Environment: """ + ENVIRONMENT + """</em></p>
        </body>
        </html>
        """)

@app.get("/frontend/{file_path:path}")
async def serve_frontend(file_path: str):
    return FileResponse(os.path.join('frontend', file_path))

# GPS Location Endpoint - With Rate Limiting
@app.post("/gps")
@limiter.limit("60/minute")
async def receive(request: Request, loc: Loc):
    """Receive GPS location data"""
    try:
        lat = loc.get_lat()
        lng = loc.get_lng()
        
        if lat is None or lng is None:
            raise HTTPException(status_code=400, detail="Missing latitude or longitude")
        
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute(
            'INSERT INTO locations (user_id, latitude, longitude, accuracy) VALUES (?, ?, ?, ?)',
            (loc.user_id, lat, lng, loc.accuracy)
        )
        conn.commit()
        conn.close()
        
        logger.info(f"Location saved: {loc.user_id} at ({lat}, {lng})")
        return {"ok": True, "message": "Location saved"}
    
    except Exception as e:
        logger.error(f"Error saving location: {e}")
        raise HTTPException(status_code=500, detail="Failed to save location")
    
    
@app.get("/locations/{user_id}")
@limiter.limit("30/minute")
async def get_user_locations(request: Request, user_id: str):
    """Get all locations for a specific user"""
    try:
        conn = sqlite3.connect('locations.db')
        c = conn.cursor()
        c.execute(
            'SELECT latitude, longitude, timestamp FROM locations WHERE user_id = ? ORDER BY timestamp DESC LIMIT 1000',
            (user_id,)
        )
        rows = c.fetchall()
        conn.close()
        
        locations = [
            {"lat": row[0], "lng": row[1], "timestamp": row[2]}
            for row in rows
        ]
        
        return {"user_id": user_id, "count": len(locations), "locations": locations}
    
    except Exception as e:
        logger.error(f"Error fetching locations: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch locations")

@app.post("/trip/set-destination")
@limiter.limit("10/minute")
async def set_destination(request: Request, trip: Destination):
    """Set a destination for a user trip"""
    try:
        conn = sqlite3.connect('locations.db')
        c = conn.cursor()
        
        # Check if user has active trip
        c.execute(
            'SELECT id FROM user_trips WHERE user_id = ? AND message_sent = 0',
            (trip.user_id,)
        )
        existing = c.fetchone()
        
        if existing:
            # Update existing trip
            c.execute(
                '''UPDATE user_trips 
                   SET destination_lat = ?, destination_lng = ?, geofence_radius = ?, contacts = ?
                   WHERE user_id = ? AND message_sent = 0''',
                (trip.destination_lat, trip.destination_lng, trip.geofence_radius, 
                 json.dumps(trip.contacts), trip.user_id)
            )
        else:
            # Create new trip
            c.execute(
                '''INSERT INTO user_trips (user_id, destination_lat, destination_lng, geofence_radius, contacts)
                   VALUES (?, ?, ?, ?, ?)''',
                (trip.user_id, trip.destination_lat, trip.destination_lng, trip.geofence_radius, 
                 json.dumps(trip.contacts))
            )
        
        conn.commit()
        conn.close()
        
        logger.info(f"Destination set for user: {trip.user_id}")
        return {"ok": True, "message": "Destination set", "user_id": trip.user_id}
    
    except Exception as e:
        logger.error(f"Error setting destination: {e}")
        raise HTTPException(status_code=500, detail="Failed to set destination")

@app.post("/trip/check-arrival")
@limiter.limit("60/minute")
async def check_arrival(request: Request, loc: Loc):
    """Check if user has reached destination"""
    try:
        conn = sqlite3.connect('locations.db')
        c = conn.cursor()
        
        # Get active trip for user
        c.execute(
            '''SELECT id, destination_lat, destination_lng, geofence_radius, contacts, message_sent
               FROM user_trips WHERE user_id = ? AND message_sent = 0''',
            (loc.user_id,)
        )
        trip = c.fetchone()
        
        if not trip:
            conn.close()
            return {"ok": False, "message": "No active trip", "arrived": False}
        
        trip_id, dest_lat, dest_lng, radius, contacts_json, message_sent = trip
        contacts = json.loads(contacts_json) if contacts_json else []
        
        # Calculate distance
        distance = geodesic(
            (loc.get_lat(), loc.get_lng()),
            (dest_lat, dest_lng)
        ).meters
        
        arrived = distance <= radius
        
        if arrived and not message_sent and contacts:
            # Send notifications
            try:
                success_count = 0
                for phone in contacts:
                    try:
                        message_body = f"SafeReach: User has safely reached their destination!\n\nTime: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
                        send_sms(phone, message_body)
                        success_count += 1
                    except Exception as e:
                        logger.error(f"Error sending SMS to {phone}: {e}")
                
                # Mark trip as completed
                c.execute(
                    'UPDATE user_trips SET message_sent = 1, completed_at = ? WHERE id = ?',
                    (datetime.utcnow(), trip_id)
                )
                conn.commit()
                
                logger.info(f"Arrival notification sent to {success_count} contacts for user {loc.user_id}")
            except Exception as e:
                logger.error(f"Error sending arrival notifications: {e}")
        
        conn.close()
        
        return {
            "ok": True,
            "user_id": loc.user_id,
            "arrived": arrived,
            "distance": round(distance, 2),
            "geofence_radius": radius,
            "notifications_sent": arrived and message_sent
        }
    
    except Exception as e:
        logger.error(f"Error checking arrival: {e}")
        raise HTTPException(status_code=500, detail="Failed to check arrival")

@app.post("/nearby-places")
@limiter.limit("20/minute")
async def nearby_places(request: Request, req: NearbyPlacesRequest):
    """Get nearby places from Google Maps"""
    try:
        places = get_nearby_places(
            req.latitude,
            req.longitude,
            req.radius,
            req.place_type
        )
        
        formatted_places = []
        for place in places:
            formatted_places.append({
                "name": place.get("name", "Unknown"),
                "type": req.place_type,
                "lat": place.get("lat", req.latitude),
                "lng": place.get("lng", req.longitude),
                "rating": place.get("rating", 0),
                "address": place.get("address", "")
            })
        
        return {"ok": True, "places": formatted_places}
    
    except Exception as e:
        logger.error(f"Error fetching nearby places: {e}")
        return {"ok": False, "error": "Failed to fetch places", "places": []}

@app.post("/send-message")
@limiter.limit("10/minute")
async def send_message(request: Request, req: SendMessageRequest):
    """Send SMS message to multiple recipients"""
    try:
        success_count = 0
        failed = []
        
        for phone in req.recipient_numbers:
            try:
                send_sms(phone, req.message)
                success_count += 1
            except Exception as e:
                failed.append({"phone": phone, "error": str(e)})
                logger.error(f"Failed to send SMS to {phone}: {e}")
        
        logger.info(f"Messages sent: {success_count} succeeded, {len(failed)} failed")
        
        return {
            "ok": True,
            "message": f"Sent to {success_count} recipients",
            "success_count": success_count,
            "failed": failed
        }
    
    except Exception as e:
        logger.error(f"Error in send_message: {e}")
        raise HTTPException(status_code=500, detail="Failed to send messages")

@app.post("/trip/reset")
@limiter.limit("10/minute")
async def reset_trip_new(request: Request, req: ResetTripRequest):
    """Reset trip for user"""
    try:
        conn = sqlite3.connect('locations.db')
        c = conn.cursor()
        
        c.execute(
            'UPDATE user_trips SET message_sent = 1, completed_at = ? WHERE user_id = ? AND message_sent = 0',
            (datetime.utcnow(), req.user_id)
        )
        rows_affected = c.rowcount
        conn.commit()
        conn.close()
        
        logger.info(f"Trip reset for user: {req.user_id}")
        
        return {
            "ok": True,
            "message": "Trip reset" if rows_affected > 0 else "No active trip found",
            "user_id": req.user_id
        }
    
    except Exception as e:
        logger.error(f"Error resetting trip: {e}")
        raise HTTPException(status_code=500, detail="Failed to reset trip")

# Data cleanup endpoint (run this periodically)
@app.post("/admin/cleanup")
async def cleanup_old_data(days: int = 30, x_api_key: str = Depends(verify_api_key)):
    """Delete location data older than specified days"""
    try:
        cutoff_date = datetime.utcnow() - timedelta(days=days)
        
        conn = sqlite3.connect('locations.db')
        c = conn.cursor()
        c.execute('DELETE FROM locations WHERE timestamp < ?', (cutoff_date,))
        deleted_locations = c.rowcount
        
        c.execute('DELETE FROM user_trips WHERE completed_at < ? AND message_sent = 1', (cutoff_date,))
        deleted_trips = c.rowcount
        
        conn.commit()
        conn.close()
        
        logger.info(f"Cleanup: Deleted {deleted_locations} locations and {deleted_trips} trips")
        
        return {
            "ok": True,
            "deleted_locations": deleted_locations,
            "deleted_trips": deleted_trips,
            "cutoff_date": cutoff_date.isoformat()
        }
    
    except Exception as e:
        logger.error(f"Error during cleanup: {e}")
        raise HTTPException(status_code=500, detail="Cleanup failed")

# Run server
if __name__ == "__main__":
    import uvicorn
    # Use PORT from environment (Render sets this)
    port = int(os.getenv("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)