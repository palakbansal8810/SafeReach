import googlemaps
from datetime import datetime
from dotenv import load_dotenv
import os
import logging

load_dotenv()

logger = logging.getLogger(__name__)

# Load API key from environment
API_KEY = os.getenv("GMAPS_API_KEY")

if not API_KEY:
    logger.error("Missing Google Maps API key in environment variables")
    raise ValueError("GMAPS_API_KEY not configured. Check your .env file")

# Initialize Google Maps client
try:
    gmaps = googlemaps.Client(key=API_KEY)
    logger.info("Google Maps client initialized successfully")
except Exception as e:
    logger.error(f"Failed to initialize Google Maps client: {e}")
    raise

def find_nearby_places(lat, lon, place_type, radius=1000):
    """
    Find nearby places using Google Maps Places API
    
    Args:
        lat: Latitude
        lon: Longitude
        place_type: Type of place (e.g., 'restaurant', 'hospital', 'atm', 'park')
        radius: Search radius in meters (default 1000m = 1km)
        
    Returns:
        list: List of place dictionaries
    """
    try:
        # Validate inputs
        if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
            raise ValueError(f"Invalid coordinates: ({lat}, {lon})")
        
        if radius < 100 or radius > 50000:
            logger.warning(f"Radius {radius} out of recommended range (100-50000m). Clamping.")
            radius = max(100, min(50000, radius))
        
        # Perform nearby search
        places_result = gmaps.places_nearby(
            location=(lat, lon),
            radius=radius,
            type=place_type
        )
        
        results = places_result.get('results', [])
        logger.info(f"Found {len(results)} places of type '{place_type}' near ({lat}, {lon})")
        
        return results
    
    except googlemaps.exceptions.ApiError as e:
        logger.error(f"Google Maps API error: {e}")
        return []
    except Exception as e:
        logger.error(f"Error searching for places: {e}")
        return []

def get_nearby_places(lat, lon, radius=1000, place_type='restaurant'):
    """
    Get nearby places - wrapper for find_nearby_places that returns structured data
    
    Args:
        lat: Latitude
        lon: Longitude
        radius: Search radius in meters
        place_type: Type of place to search for
        
    Returns:
        List of dictionaries with place information
    """
    try:
        places = find_nearby_places(lat, lon, place_type, radius)
        
        result = []
        for place in places:
            location = place.get('geometry', {}).get('location', {})
            result.append({
                'name': place.get('name', 'Unknown'),
                'lat': location.get('lat', lat),
                'lng': location.get('lng', lon),
                'rating': place.get('rating', 0),
                'address': place.get('vicinity', ''),
                'type': place_type,
                'place_id': place.get('place_id', '')
            })
        
        return result
    
    except Exception as e:
        logger.error(f"Error in get_nearby_places: {e}")
        return []

def display_places(places):
    """Display found places in a readable format (for CLI usage)"""
    if not places:
        print("No places found in this area.")
        return
    
    print(f"\nFound {len(places)} place(s):\n")
    print("-" * 70)
    
    for i, place in enumerate(places, 1):
        name = place.get('name', 'Unknown')
        address = place.get('vicinity', 'Address not available')
        rating = place.get('rating', 'No rating')
        is_open = place.get('opening_hours', {}).get('open_now')
        
        # Get latitude and longitude
        location = place.get('geometry', {}).get('location', {})
        lat = location.get('lat', 'N/A')
        lng = location.get('lng', 'N/A')
        
        print(f"{i}. {name}")
        print(f"   Address: {address}")
        print(f"   Coordinates: ({lat}, {lng})")
        print(f"   Rating: {rating}")
        
        if is_open is not None:
            status = "Open now" if is_open else "Closed"
            print(f"   Status: {status}")
        
        print("-" * 70)

# CLI helper (only runs when script is executed directly)
if __name__ == "__main__":
    print("=== Google Maps Nearby Location Finder ===\n")

    # Common place types
    place_types = [
        'restaurant', 'cafe', 'hospital', 'pharmacy', 'atm', 
        'bank', 'gas_station', 'parking', 'shopping_mall', 
        'supermarket', 'gym', 'park', 'library', 'school'
    ]

    try:
        # Get user input
        user_lat = float(input("Enter your latitude: "))
        user_lon = float(input("Enter your longitude: "))
        
        print("\nAvailable place types:")
        for i, ptype in enumerate(place_types, 1):
            print(f"{i}. {ptype.replace('_', ' ').title()}")
        
        choice = int(input("\nSelect place type (enter number): "))
        
        if 1 <= choice <= len(place_types):
            selected_type = place_types[choice - 1]
        else:
            print("Invalid choice. Using 'restaurant' as default.")
            selected_type = 'restaurant'
        
        radius = int(input("Enter search radius in meters (default 1000): ") or 1000)
        
        print(f"\nSearching for {selected_type.replace('_', ' ')}s within {radius}m...\n")
        
        # Find nearby places
        places = find_nearby_places(user_lat, user_lon, selected_type, radius)
        
        # Display results
        display_places(places)

    except ValueError:
        print("Error: Please enter valid numeric values.")
    except Exception as e:
        print(f"An error occurred: {e}")
        print("\nNote: Make sure you have:")
        print("1. Set GMAPS_API_KEY in your .env file")
        print("2. Installed googlemaps package: pip install googlemaps")