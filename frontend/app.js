// SafeReach Application - Main JavaScript File
// Well-structured vanilla JavaScript application
// Add this at the top of app.js, after the API_BASE declaration


// Update API_BASE for native apps
const isCapacitor = () => {
    return window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform();
};

// Access Capacitor plugins through the native bridge (works in Android Studio builds)
const getCapacitorPlugin = (name) => {
    if (!isCapacitor()) return null;
    if (window.Capacitor?.Plugins?.[name]) return window.Capacitor.Plugins[name];
    if (window.Capacitor?.registerPlugin) return window.Capacitor.registerPlugin(name);
    return null;
};

const getApiBase = () => {
    // Allow overriding without rebuilding (useful for emulator vs real device)
    const saved = localStorage.getItem('safereach_api_base');
    if (saved) return saved.replace(/\/+$/, '');

    if (!isCapacitor()) return window.location.origin;

    // Android emulator -> host machine
    // If you're on a real phone, set localStorage safereach_api_base to your PC's LAN IP (ex: http://192.168.x.x:8000)
    return 'http://10.0.2.2:8000';
};

const API_BASE = getApiBase();

// Application State
const AppState = {
    currentStep: 'permission',
    userId: '',
    currentLocation: null,
    destination: null,
    contacts: [],
    selectedContacts: [],
    message: "I've reached safely! 🎉",
    tracking: false,
    arrived: false,
    geofenceRadius: 500,
    placeType: 'restaurant',
    searchRadius: 1000,
    distance: null,
    updateCount: 0,
    watchId: null,
    lastTrackingCallback: null,
    pollIntervalId: null,
    backgroundTrackingActive: false,
    map: null,
    currentMarker: null,
    destinationMarker: null,
    placesMarkers: [],
    geofenceCircle: null
};

const Utils = {
    // Calculate distance using Haversine formula
    calculateDistance(lat1, lng1, lat2, lng2) {
        const R = 6371000; // Earth radius in meters
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLng = (lng2 - lng1) * Math.PI / 180;
        const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                  Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                  Math.sin(dLng/2) * Math.sin(dLng/2);
        const c = 2 * Math.asin(Math.sqrt(a));
        return R * c;
    },

    formatDistance(meters) {
        if (meters === null || meters === undefined) return 'Calculating...';
        if (meters < 1000) return `${Math.round(meters)}m`;
        return `${(meters / 1000).toFixed(2)}km`;
    },

    showError(elementId, message) {
        const element = document.getElementById(elementId);
        if (element) {
            element.textContent = message;
            element.classList.remove('hidden');
        }
    },

    hideError(elementId) {
        const element = document.getElementById(elementId);
        if (element) {
            element.classList.add('hidden');
        }
    },

    showSuccess(elementId, message) {
        const element = document.getElementById(elementId);
        if (element) {
            element.textContent = message;
            element.classList.remove('hidden');
        }
    },

    hideSuccess(elementId) {
        const element = document.getElementById(elementId);
        if (element) {
            element.classList.add('hidden');
        }
    }
};
// Step Management
const StepManager = {
    showStep(stepName) {
        // Hide all steps
        document.querySelectorAll('.step').forEach(step => {
            step.classList.remove('active');
        });
        
        // Show requested step
        const step = document.getElementById(`step-${stepName}`);
        if (step) {
            step.classList.add('active');
            AppState.currentStep = stepName;
        }
    },

    nextStep() {
        const steps = ['permission', 'contacts', 'destination', 'message', 'tracking', 'complete'];
        const currentIndex = steps.indexOf(AppState.currentStep);
        if (currentIndex < steps.length - 1) {
            this.showStep(steps[currentIndex + 1]);
        }
    }
};

// Location Services with Pure Capacitor Support
const LocationService = {
    async requestPermission() {
        if (!AppState.userId.trim()) {
            Utils.showError('permissionError', 'Please enter your name first');
            return null;
        }

        // Use Capacitor Geolocation if available
        const CapGeo = getCapacitorPlugin('Geolocation') || window.CapacitorGeolocation;
        if (isCapacitor() && CapGeo) {
            try {
                // Request permissions (including background on Android 10+)
                const permission = await CapGeo.requestPermissions();
                console.log('Permission status:', permission);
                
                // Get current position
                const position = await CapGeo.getCurrentPosition({
                    enableHighAccuracy: true,
                    timeout: 10000,
                    maximumAge: 0
                });
                
                const loc = {
                    lat: position.coords.latitude,
                    lng: position.coords.longitude,
                    accuracy: position.coords.accuracy
                };
                AppState.currentLocation = loc;
                return loc;
            } catch (error) {
                console.error('Capacitor geolocation error:', error);
                let errorMsg = 'Location permission denied. ';
                if (error.message) {
                    errorMsg += error.message;
                } else {
                    errorMsg += 'Please enable location access in your device settings.';
                }
                Utils.showError('permissionError', errorMsg);
                return null;
            }
        }
        
        // Fallback to browser geolocation
        if (!navigator.geolocation) {
            Utils.showError('permissionError', 'Geolocation is not supported by your browser');
            return null;
        }

        return new Promise((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    const loc = {
                        lat: position.coords.latitude,
                        lng: position.coords.longitude,
                        accuracy: position.coords.accuracy
                    };
                    AppState.currentLocation = loc;
                    resolve(loc);
                },
                (error) => {
                    let errorMsg = 'Location permission denied. ';
                    switch(error.code) {
                        case error.PERMISSION_DENIED:
                            errorMsg += 'Please enable location access in your browser settings.';
                            break;
                        case error.POSITION_UNAVAILABLE:
                            errorMsg += 'Location information is unavailable.';
                            break;
                        case error.TIMEOUT:
                            errorMsg += 'Location request timed out.';
                            break;
                        default:
                            errorMsg += error.message;
                    }
                    Utils.showError('permissionError', errorMsg);
                    reject(error);
                },
                {
                    enableHighAccuracy: true,
                    timeout: 10000,
                    maximumAge: 0
                }
            );
        });
    },

    startTracking(callback) {
        // Use Capacitor for native apps
        const CapGeo = getCapacitorPlugin('Geolocation') || window.CapacitorGeolocation;
        if (isCapacitor() && CapGeo) {
            return this.startCapacitorTracking(callback);
        }
        
        // Fallback to browser geolocation (foreground only)
        if (!navigator.geolocation) {
            Utils.showError('trackingError', 'Geolocation is not supported');
            return null;
        }

        AppState.watchId = navigator.geolocation.watchPosition(
            (position) => {
                const loc = {
                    lat: position.coords.latitude,
                    lng: position.coords.longitude,
                    accuracy: position.coords.accuracy
                };
                AppState.currentLocation = loc;
                AppState.updateCount++;
                
                if (callback) callback(loc);
            },
            (error) => {
                console.error('Tracking error:', error);
                Utils.showError('trackingError', 'Location tracking error: ' + error.message);
            },
            { 
                enableHighAccuracy: true, 
                timeout: 10000,
                maximumAge: 5000
            }
        );

        AppState.lastTrackingCallback = callback;
        return AppState.watchId;
    },

    async startCapacitorTracking(callback) {
        const CapGeo = getCapacitorPlugin('Geolocation') || window.CapacitorGeolocation;
        if (!CapGeo) {
            Utils.showError('trackingError', 'Geolocation plugin not available');
            return null;
        }

        // Helper to update location + callback from a position object
        const applyPosition = (position) => {
            if (!position) return;
            const loc = {
                lat: position.coords.latitude,
                lng: position.coords.longitude,
                accuracy: position.coords.accuracy
            };
            AppState.currentLocation = loc;
            AppState.updateCount++;
            
            if (callback) callback(loc);
        };

        let watcherId = null;

        // CRITICAL: Try background geolocation first
        const BgGeo = getCapacitorPlugin('BackgroundGeolocation') || window.BackgroundGeolocation;
        if (BgGeo) {
            try {
                watcherId = await this.setupBackgroundTracking(callback);
                if (watcherId) {
                    console.log('âœ… Background tracking started successfully');
                }
            } catch (error) {
                console.warn('âš ï¸ Background tracking failed, using foreground:', error);
            }
        } else {
            console.warn('âš ï¸ BackgroundGeolocation plugin not available - tracking will stop when app closes');
        }

        // Fallback to foreground tracking
        if (!watcherId) {
            try {
                const watchId = await CapGeo.watchPosition(
                    {
                        enableHighAccuracy: true,
                        timeout: 10000,
                        maximumAge: 5000
                    },
                    (position, err) => {
                        if (err) {
                            console.error('Capacitor tracking error:', err);
                            if (!AppState.backgroundTrackingActive) {
                                Utils.showError('trackingError', 'Location tracking error: ' + err.message);
                            }
                            return;
                        }
    
                        applyPosition(position);
                    }
                );
    
                AppState.watchId = watchId;
            } catch (error) {
                console.error('Error starting Capacitor tracking:', error);
                Utils.showError('trackingError', 'Failed to start tracking: ' + error.message);
                return null;
            }
        }

        AppState.lastTrackingCallback = callback;

        // Additionally, poll location every 15 seconds to ensure periodic updates,
        // even when BackgroundGeolocation is active.
        if (AppState.pollIntervalId) {
            clearInterval(AppState.pollIntervalId);
        }
        AppState.pollIntervalId = setInterval(async () => {
            try {
                const latestCapGeo = getCapacitorPlugin('Geolocation') || window.CapacitorGeolocation;
                if (!latestCapGeo) return;
                const position = await latestCapGeo.getCurrentPosition({
                    enableHighAccuracy: true,
                    timeout: 10000,
                    maximumAge: 0
                });
                applyPosition(position);
            } catch (e) {
                console.warn('Periodic location fetch failed:', e);
            }
        }, 15000); // 15 seconds

        return watcherId || AppState.watchId;
    },

    async setupBackgroundTracking(callback) {
        const BgGeo = getCapacitorPlugin('BackgroundGeolocation') || window.BackgroundGeolocation;
        if (!BgGeo) {
            throw new Error('BackgroundGeolocation plugin not available');
        }

        try {
            // Configure background geolocation with proper settings
            const config = {
                // Location accuracy
                desiredAccuracy: BgGeo.DESIRED_ACCURACY_HIGH || 0,
                stationaryRadius: 20,
                distanceFilter: 10,
                
                // Notification (required for Android foreground service)
                notificationTitle: 'SafeReach Tracking',
                notificationText: 'Tracking your journey to destination',
                
                // Background tracking (15 second cadence)
                startOnBoot: false,
                stopOnTerminate: false,
                
                // Update intervals
                interval: 15000, // 15 seconds
                fastestInterval: 15000,
                activitiesInterval: 15000,
                
                // Keep tracking even when stationary
                stopOnStillActivity: false,
                
                // Android foreground service
                startForeground: true,
                
                // Debug
                debug: false,
                
                // Location provider
                locationProvider: BgGeo.ANDROID_ACTIVITY_PROVIDER || 0
            };

            console.log('Configuring background geolocation...');

            // Add watcher
            const watcherId = await BgGeo.addWatcher(
                {
                    backgroundMessage: "Tracking your journey",
                    backgroundTitle: "SafeReach Active",
                    requestPermissions: true,
                    stale: false,
                    distanceFilter: 10
                },
                function(location, error) {
                    if (error) {
                        if (error.code === 'NOT_AUTHORIZED') {
                            console.warn('Background location not authorized');
                            Utils.showError('trackingError', 'Please enable background location in settings');
                        }
                        console.error('Background geolocation error:', error);
                        return;
                    }

                    if (location) {
                        console.log('ðŸ“ Background location update:', location);
                        const loc = {
                            lat: location.latitude,
                            lng: location.longitude,
                            accuracy: location.accuracy
                        };
                        AppState.currentLocation = loc;
                        AppState.updateCount++;
                        
                        if (callback) callback(loc);
                    }
                }
            );

            AppState.backgroundWatcherId = watcherId;
            AppState.backgroundTrackingActive = true;
            
            console.log('âœ… Background geolocation watcher added:', watcherId);
            showTrackingBanner();
            
            return watcherId;
        } catch (error) {
            console.error('âŒ Failed to setup background tracking:', error);
            throw error;
        }
    },

    async stopTracking() {
        console.log('Stopping all tracking...');

        // Stop periodic polling
        if (AppState.pollIntervalId) {
            clearInterval(AppState.pollIntervalId);
            AppState.pollIntervalId = null;
        }
        
        // Stop Capacitor watch if active
        const CapGeo = getCapacitorPlugin('Geolocation') || window.CapacitorGeolocation;
        if (isCapacitor() && AppState.watchId && CapGeo) {
            try {
                await CapGeo.clearWatch({ id: AppState.watchId });
                console.log('Cleared Capacitor watch');
            } catch (err) {
                console.error('Error clearing watch:', err);
            }
        }
        
        // Stop background geolocation if active
        const BgGeo = getCapacitorPlugin('BackgroundGeolocation') || window.BackgroundGeolocation;
        if (BgGeo && AppState.backgroundTrackingActive) {
            try {
                if (AppState.backgroundWatcherId) {
                    await BgGeo.removeWatcher({
                        id: AppState.backgroundWatcherId
                    });
                    console.log('âœ… Background geolocation stopped');
                }
                AppState.backgroundTrackingActive = false;
                AppState.backgroundWatcherId = null;
            } catch (err) {
                console.error('Error stopping background geolocation:', err);
            }
        }
        
        // Stop browser geolocation if active
        if (AppState.watchId !== null && navigator.geolocation) {
            navigator.geolocation.clearWatch(AppState.watchId);
        }
        
        AppState.watchId = null;
    },

    async sendLocationToServer(loc) {
        try {
            const response = await fetch(`${API_BASE}/gps`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_id: AppState.userId,
                    latitude: loc.lat,
                    longitude: loc.lng,
                    accuracy: loc.accuracy,
                    timestamp: new Date().toISOString()
                })
            });
            
            if (response.ok) {
                console.log('ðŸ“¤ Location sent to server');
            }
        } catch (err) {
            console.error('Error sending location:', err);
        }
    }
};

// Wake Lock & PWA helpers (best-effort improvements for keeping tracking alive when possible)
let wakeLock = null;
async function requestWakeLock() {
    if ('wakeLock' in navigator) {
        try {
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', () => console.log('Wake Lock released'));
            console.log('Wake Lock acquired');
        } catch (err) {
            console.warn('Wake Lock request failed:', err);
        }
    }
}

function releaseWakeLock() {
    if (wakeLock) {
        try {
            wakeLock.release().catch(()=>{});
        } finally {
            wakeLock = null;
        }
    }
}


// PWA install prompt
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    const btn = document.getElementById('installPwaBtn');
    if (btn) btn.classList.remove('hidden');
});

window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    const btn = document.getElementById('installPwaBtn');
    if (btn) btn.classList.add('hidden');
});

// Re-acquire resources when visibility changes
document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
        if (AppState.tracking) {
            try { await requestWakeLock(); } catch (e) { /* ignore */ }
            if (!AppState.watchId && AppState.lastTrackingCallback) {
                LocationService.startTracking(AppState.lastTrackingCallback);
            }
        }
    }
});

// Map Services
const MapService = {
    initMap() {
        if (!window.google || !window.google.maps) {
            console.error('Google Maps API not loaded');
            return;
        }

        if (!AppState.currentLocation) {
            console.error('No current location available');
            return;
        }

        const mapContainer = document.getElementById('map');
        if (!mapContainer) return;

        // Initialize map
        AppState.map = new google.maps.Map(mapContainer, {
            center: { lat: AppState.currentLocation.lat, lng: AppState.currentLocation.lng },
            zoom: 15,
            mapTypeControl: true,
            streetViewControl: true,
            fullscreenControl: true
        });

        // Add current location marker
        this.addCurrentLocationMarker();

        // Add click listener to select destination
        AppState.map.addListener('click', (event) => {
            this.selectDestinationFromMap(event.latLng.lat(), event.latLng.lng());
        });

        // Hide overlay
        const overlay = mapContainer.parentElement.querySelector('.map-overlay');
        if (overlay) overlay.style.display = 'none';
    },

    addCurrentLocationMarker() {
        if (!AppState.map || !AppState.currentLocation) return;

        if (AppState.currentMarker) {
            AppState.currentMarker.setMap(null);
        }

        AppState.currentMarker = new google.maps.Marker({
            position: { lat: AppState.currentLocation.lat, lng: AppState.currentLocation.lng },
            map: AppState.map,
            title: 'Your Current Location',
            icon: {
                url: 'http://maps.google.com/mapfiles/ms/icons/blue-dot.png'
            }
        });
    },

    selectDestinationFromMap(lat, lng) {
        AppState.destination = {
            name: 'Selected Location',
            lat: lat,
            lng: lng,
            address: `${lat.toFixed(4)}, ${lng.toFixed(4)}`
        };

        // Add destination marker
        if (AppState.destinationMarker) {
            AppState.destinationMarker.setMap(null);
        }

        AppState.destinationMarker = new google.maps.Marker({
            position: { lat: lat, lng: lng },
            map: AppState.map,
            title: 'Destination',
            icon: {
                url: 'http://maps.google.com/mapfiles/ms/icons/red-dot.png'
            },
            draggable: true
        });

        // Update destination when marker is dragged
        AppState.destinationMarker.addListener('dragend', (event) => {
            AppState.destination.lat = event.latLng.lat();
            AppState.destination.lng = event.latLng.lng();
            AppState.destination.address = `${AppState.destination.lat.toFixed(4)}, ${AppState.destination.lng.toFixed(4)}`;
        });

        // Draw circle for geofence
        this.drawGeofence();

        // Show next button
        document.getElementById('nextToMessageBtn').classList.remove('hidden');
    },

    drawGeofence() {
        if (!AppState.map || !AppState.destination) return;

        // Remove existing circle if any
        if (AppState.geofenceCircle) {
            AppState.geofenceCircle.setMap(null);
        }

        AppState.geofenceCircle = new google.maps.Circle({
            strokeColor: '#FF0000',
            strokeOpacity: 0.8,
            strokeWeight: 2,
            fillColor: '#FF0000',
            fillOpacity: 0.35,
            map: AppState.map,
            center: { lat: AppState.destination.lat, lng: AppState.destination.lng },
            radius: AppState.geofenceRadius
        });
    },

    async searchNearbyPlaces() {
        if (!AppState.currentLocation) {
            Utils.showError('destinationError', 'Location not available');
            return;
        }

        Utils.hideError('destinationError');

        try {
            const response = await fetch(`${API_BASE}/nearby-places`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    latitude: AppState.currentLocation.lat,
                    longitude: AppState.currentLocation.lng,
                    radius: AppState.searchRadius,
                    place_type: AppState.placeType
                })
            });

            if (!response.ok) throw new Error('Failed to fetch places');

            const data = await response.json();
            const places = data.places || [];

            if (places.length === 0) {
                Utils.showError('destinationError', 'No places found nearby. Try increasing the search radius.');
            } else {
                this.displayPlaces(places);
            }
        } catch (err) {
            console.error('Error searching places:', err);
            Utils.showError('destinationError', 'Error searching places. Make sure the server is running.');
        }
    },

    displayPlaces(places) {
        const placesList = document.getElementById('placesList');
        if (!placesList) return;

        // Clear existing markers
        AppState.placesMarkers.forEach(marker => marker.setMap(null));
        AppState.placesMarkers = [];

        // Clear list
        placesList.innerHTML = '';

        places.forEach((place, index) => {
            // Add marker to map
            const marker = new google.maps.Marker({
                position: { lat: place.lat, lng: place.lng },
                map: AppState.map,
                title: place.name,
                icon: {
                    url: 'http://maps.google.com/mapfiles/ms/icons/green-dot.png'
                }
            });

            marker.addListener('click', () => {
                this.selectPlace(place);
            });

            AppState.placesMarkers.push(marker);

            // Calculate distance
            const distance = AppState.currentLocation 
                ? Utils.calculateDistance(
                    AppState.currentLocation.lat, AppState.currentLocation.lng,
                    place.lat, place.lng
                  )
                : null;

            // Create place card
            const card = document.createElement('div');
            card.className = 'place-card';
            card.innerHTML = `
                <h3>${place.name}</h3>
                <p class="place-rating">⭐ ${place.rating || 'N/A'}</p>
                <p class="place-address">${place.address || 'Address unavailable'}</p>
                ${distance ? `<p class="place-distance">📍 ${Utils.formatDistance(distance)} away</p>` : ''}
                <button class="btn btn-select" data-index="${index}">Select Destination</button>
            `;
                
            card.querySelector('.btn-select').addEventListener('click', () => {
                this.selectPlace(place);
            });

            placesList.appendChild(card);
        });
    },

    searchByQuery(query) {
        if (!AppState.map || !AppState.currentLocation) {
            Utils.showError('destinationError', 'Map or location not ready');
            return;
        }

        Utils.hideError('destinationError');

        const service = new google.maps.places.PlacesService(AppState.map);
        const request = {
            query: query,
            location: new google.maps.LatLng(AppState.currentLocation.lat, AppState.currentLocation.lng),
            radius: AppState.searchRadius
        };

        service.textSearch(request, (results, status) => {
            if (status === google.maps.places.PlacesServiceStatus.OK && results && results.length) {
                const mapped = results.map(r => ({
                    name: r.name,
                    lat: r.geometry.location.lat(),
                    lng: r.geometry.location.lng(),
                    rating: r.rating || 'N/A',
                    address: r.formatted_address || r.vicinity || ''
                }));
                this.displayPlaces(mapped);
                AppState.map.setCenter({ lat: mapped[0].lat, lng: mapped[0].lng });
            } else {
                Utils.showError('destinationError', 'No places found for that query.');
            }
        });
    },

    selectPlace(place) {
        AppState.destination = place;
        
        // Update destination marker
        if (AppState.destinationMarker) {
            AppState.destinationMarker.setMap(null);
        }

        AppState.destinationMarker = new google.maps.Marker({
            position: { lat: place.lat, lng: place.lng },
            map: AppState.map,
            title: place.name,
            icon: {
                url: 'http://maps.google.com/mapfiles/ms/icons/red-dot.png'
            }
        });

        // Center map on destination
        AppState.map.setCenter({ lat: place.lat, lng: place.lng });

        // Draw geofence
        this.drawGeofence();

        // Show next button
        document.getElementById('nextToMessageBtn').classList.remove('hidden');
    }
};
// Contact Management
const ContactManager = {
    addContact() {
        const name = document.getElementById('contactName').value.trim();
        const phone = document.getElementById('contactPhone').value.trim();

        if (!name || !phone) {
            Utils.showError('contactsError', 'Please enter both name and phone number');
            return;
        }

        if (!/^\+?\d{10,15}$/.test(phone.replace(/[\s-]/g, ''))) {
            Utils.showError('contactsError', 'Please enter a valid phone number');
            return;
        }

        const contact = { name, phone };
        AppState.contacts.push(contact);
        AppState.selectedContacts.push(phone);

        // Clear inputs
        document.getElementById('contactName').value = '';
        document.getElementById('contactPhone').value = '';

        Utils.hideError('contactsError');
        this.renderContacts();
        this.saveContacts();
    },

    removeContact(index) {
        const phoneToRemove = AppState.contacts[index].phone;
        AppState.contacts.splice(index, 1);
        AppState.selectedContacts = AppState.selectedContacts.filter(p => p !== phoneToRemove);
        this.renderContacts();
        this.saveContacts();
    },

    toggleContact(phone) {
        const index = AppState.selectedContacts.indexOf(phone);
        if (index > -1) {
            AppState.selectedContacts.splice(index, 1);
        } else {
            AppState.selectedContacts.push(phone);
        }
        this.renderContactCheckboxes();
    },

    renderContacts() {
        const contactsList = document.getElementById('contactsList');
        if (!contactsList) return;

        if (AppState.contacts.length === 0) {
            contactsList.innerHTML = `
                <div class="empty-state">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" opacity="0.3">
                        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                        <circle cx="9" cy="7" r="4"></circle>
                    </svg>
                    <p>No contacts added yet</p>
                </div>
            `;
            document.getElementById('nextToMapBtn').classList.add('hidden');
        } else {
            // FIXED: Complete HTML structure with remove button
            contactsList.innerHTML = AppState.contacts.map((contact, index) => `
                <div class="contact-item">
                    <div class="contact-info">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>
                        </svg>
                        <div>
                            <strong>${contact.name}</strong>
                            <span>${contact.phone}</span>
                        </div>
                    </div>
                    <button class="btn-remove" onclick="ContactManager.removeContact(${index})">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                    </button>
                </div>
            `).join('');
            document.getElementById('nextToMapBtn').classList.remove('hidden');
        }
    },

    renderContactCheckboxes() {
        const checkboxes = document.getElementById('contactsCheckboxes');
        if (!checkboxes) return;

        checkboxes.innerHTML = AppState.contacts.map((contact, index) => `
            <label class="contact-checkbox">
                <input type="checkbox" 
                       ${AppState.selectedContacts.includes(contact.phone) ? 'checked' : ''}
                       onchange="ContactManager.toggleContact('${contact.phone}')">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>
                </svg>
                ${contact.name} (${contact.phone})
            </label>
        `).join('');
    },

    saveContacts() {
        localStorage.setItem('safereach_contacts', JSON.stringify(AppState.contacts));
        localStorage.setItem('safereach_selectedContacts', JSON.stringify(AppState.selectedContacts));
    },

    loadContacts() {
        const saved = localStorage.getItem('safereach_contacts');
        if (saved) {
            try {
                AppState.contacts = JSON.parse(saved);
                const savedSelected = localStorage.getItem('safereach_selectedContacts');
                if (savedSelected) {
                    AppState.selectedContacts = JSON.parse(savedSelected);
                } else {
                    AppState.selectedContacts = AppState.contacts.map(c => c.phone);
                }
            } catch (e) {
                console.error('Error loading contacts:', e);
            }
        }
    }
};

// Tracking Service
const TrackingService = {
    async startTracking() {
        if (!AppState.destination) {
            Utils.showError('messageError', 'Please select a destination first');
            return;
        }

        if (AppState.selectedContacts.length === 0) {
            Utils.showError('messageError', 'Please select at least one contact');
            return;
        }

        Utils.hideError('messageError');

        try {
            // Set destination on server
            const response = await fetch(`${API_BASE}/trip/set-destination`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_id: AppState.userId,
                    destination_lat: AppState.destination.lat,
                    destination_lng: AppState.destination.lng,
                    geofence_radius: AppState.geofenceRadius,
                    contacts: AppState.selectedContacts
                })
            });

            if (!response.ok) throw new Error('Failed to set destination');

            AppState.tracking = true;
            StepManager.showStep('tracking');
            AppState.updateCount = 0;

            // Start location tracking
            LocationService.startTracking(async (loc) => {
                // Update UI
                this.updateTrackingUI(loc);

                // Send location to server
                await LocationService.sendLocationToServer(loc);

                // Calculate distance
                const dist = Utils.calculateDistance(
                    loc.lat, loc.lng,
                    AppState.destination.lat, AppState.destination.lng
                );
                AppState.distance = dist;

                // Update distance display
                document.getElementById('trackingDistance').textContent = Utils.formatDistance(dist);
                this.updateProgressBar(dist);

                // Check if arrived
                if (dist <= AppState.geofenceRadius && !AppState.arrived) {
                    this.handleArrival();
                }
            });

            // Try to acquire wake lock
            requestWakeLock().catch(()=>{});
            showTrackingBanner();
        } catch (err) {
            Utils.showError('messageError', 'Error starting tracking: ' + err.message);
            AppState.tracking = false;
        }
    },

    updateTrackingUI(loc) {
        document.getElementById('trackingCurrentLoc').textContent = 
            `${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)}`;
        document.getElementById('trackingAccuracy').textContent = 
            `Â±${Math.round(loc.accuracy)}m accuracy`;
        document.getElementById('updateCount').textContent = AppState.updateCount;
        document.getElementById('trackingDestination').textContent = AppState.destination.name;
        document.getElementById('trackingRadius').textContent = AppState.geofenceRadius;
    },

    updateProgressBar(distance) {
        const progressFill = document.getElementById('progressFill');
        if (progressFill) {
            const progress = Math.max(0, Math.min(100, 100 - (distance / AppState.geofenceRadius * 100)));
            progressFill.style.width = `${progress}%`;
        }
    },

    async handleArrival() {
        if (AppState.arrived) return;

        AppState.arrived = true;
        AppState.tracking = false;
        LocationService.stopTracking();
        releaseWakeLock();
        hideTrackingBanner();

        // Send message
        try {
            const fullMessage = `${AppState.message}\n\nDestination: ${AppState.destination.name}\nArrived at: ${new Date().toLocaleString()}`;
            
            const response = await fetch(`${API_BASE}/send-message`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_id: AppState.userId,
                    message: fullMessage,
                    recipient_numbers: AppState.selectedContacts
                })
            });

            if (!response.ok) throw new Error('Failed to send messages');

            // Show completion screen
            document.getElementById('sentContactsCount').textContent = AppState.selectedContacts.length;
            document.getElementById('arrivedDestinationName').textContent = AppState.destination.name;
            document.getElementById('arrivalTime').textContent = new Date().toLocaleTimeString();
            
            StepManager.showStep('complete');
        } catch (err) {
            console.error('Error sending message:', err);
            Utils.showError('trackingError', 'Arrived but failed to send notifications: ' + err.message);
            StepManager.showStep('complete');
        }
    },

    cancelTrip() {
        LocationService.stopTracking();
        releaseWakeLock();
        hideTrackingBanner();
        
        // Reset trip on server
        fetch(`${API_BASE}/trip/reset`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: AppState.userId })
        }).catch(err => console.error('Error resetting trip:', err));

        this.resetApp();
    },

    resetApp() {
        AppState.currentLocation = null;
        AppState.destination = null;
        AppState.tracking = false;
        AppState.arrived = false;
        AppState.distance = null;
        AppState.updateCount = 0;
        
        releaseWakeLock();
        hideTrackingBanner();

        if (AppState.map) {
            AppState.placesMarkers.forEach(marker => marker.setMap(null));
            AppState.placesMarkers = [];
            if (AppState.geofenceCircle) {
                AppState.geofenceCircle.setMap(null);
            }
        }

        StepManager.showStep('permission');
    }
};


// Initialize Application
const App = {
    async init() {
        this.loadSavedData();
        this.setupEventListeners();
        this.updateUI();
        
        // Initialize Capacitor plugins if available
        if (isCapacitor()) {
            await this.initCapacitor();
        }
    },

    async initCapacitor() {
        try {
            // Initialize background geolocation plugin if available
            if (window.BackgroundGeolocation) {
                console.log('Background geolocation plugin detected');
                // Plugin will be configured when tracking starts
            }
            
            // Handle app state changes
            if (window.CapacitorApp) {
                window.CapacitorApp.addListener('appStateChange', ({ isActive }) => {
                    console.log('App state changed. Is active:', isActive);
                    if (isActive && AppState.tracking && AppState.lastTrackingCallback) {
                        // Re-register tracking if app becomes active
                        LocationService.startTracking(AppState.lastTrackingCallback);
                    }
                });
            }
        } catch (error) {
            console.error('Error initializing Capacitor:', error);
        }
    },

    loadSavedData() {
        // Load userId
        const savedUserId = localStorage.getItem('safereach_userId');
        if (savedUserId) {
            AppState.userId = savedUserId;
            document.getElementById('userId').value = savedUserId;
        }

        // Load geofence radius
        const savedRadius = localStorage.getItem('safereach_radius');
        if (savedRadius) {
            AppState.geofenceRadius = parseInt(savedRadius);
        }

        // Initialize destination radius control (if present)
        const destRadiusElInit = document.getElementById('destinationRadius');
        if (destRadiusElInit) {
            destRadiusElInit.value = AppState.geofenceRadius;
            document.getElementById('destinationRadiusDisplay').textContent = AppState.geofenceRadius;
        }

        // Load contacts
        ContactManager.loadContacts();
    },

    setupEventListeners() {
        // Step 1: Permission
        document.getElementById('requestLocationBtn').addEventListener('click', async () => {
            AppState.userId = document.getElementById('userId').value.trim();
            if (!AppState.userId) {
                Utils.showError('permissionError', 'Please enter your name first');
                return;
            }
            localStorage.setItem('safereach_userId', AppState.userId);

            Utils.hideError('permissionError');
            const loc = await LocationService.requestPermission();
            if (loc) {
                Utils.showSuccess('permissionSuccess', 
                    `Location obtained: ${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)}`);
                await LocationService.sendLocationToServer(loc);
                setTimeout(() => {
                    StepManager.nextStep();
                    ContactManager.renderContacts();
                }, 1000);
            }
        });

        // Step 2: Contacts
        document.getElementById('addContactBtn').addEventListener('click', () => {
            ContactManager.addContact();
        });

        document.getElementById('nextToMapBtn').addEventListener('click', () => {
            StepManager.nextStep();
            this.initMapIfNeeded();
        });

        // Step 3: Destination
        document.getElementById('searchPlacesBtn').addEventListener('click', () => {
            MapService.searchNearbyPlaces();
        });

        // Map search input/button
        const mapSearchBtn = document.getElementById('mapSearchBtn');
        const mapSearchInput = document.getElementById('mapSearchInput');
        if (mapSearchBtn && mapSearchInput) {
            mapSearchBtn.addEventListener('click', () => {
                const q = mapSearchInput.value.trim();
                if (q) MapService.searchByQuery(q);
            });
            mapSearchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    const q = mapSearchInput.value.trim();
                    if (q) MapService.searchByQuery(q);
                }
            });
        }

        document.getElementById('placeType').addEventListener('change', (e) => {
            AppState.placeType = e.target.value;
        });

        document.getElementById('searchRadius').addEventListener('input', (e) => {
            AppState.searchRadius = parseInt(e.target.value);
            document.getElementById('radiusDisplay').textContent = AppState.searchRadius;
        });

        // Destination geofence radius control (visible on map)
        const destRadiusEl = document.getElementById('destinationRadius');
        if (destRadiusEl) {
            destRadiusEl.addEventListener('input', (e) => {
                const val = parseInt(e.target.value);
                AppState.geofenceRadius = val;
                document.getElementById('destinationRadiusDisplay').textContent = val;
                // redraw geofence on map
                if (AppState.destination && AppState.map) {
                    MapService.drawGeofence();
                }
                // persist
                localStorage.setItem('safereach_radius', val);
            });
        }

        document.getElementById('nextToMessageBtn').addEventListener('click', () => {
            if (!AppState.destination) {
                Utils.showError('destinationError', 'Please select a destination first');
                return;
            }
            this.updateMessageStep();
            StepManager.nextStep();
        });

        // Step 4: Message
        document.getElementById('customMessage').addEventListener('input', (e) => {
            AppState.message = e.target.value;
        });



        document.getElementById('startTrackingBtn').addEventListener('click', () => {
            TrackingService.startTracking();
        });

        // Step 5: Tracking
        document.getElementById('cancelTripBtn').addEventListener('click', () => {
            if (confirm('Are you sure you want to cancel this trip?')) {
                TrackingService.cancelTrip();
            }
        });

        // Step 6: Complete
        document.getElementById('startNewJourneyBtn').addEventListener('click', () => {
            TrackingService.resetApp();
        });

        // Install PWA button (shown when beforeinstallprompt fires)
        const installBtn = document.getElementById('installPwaBtn');
        if (installBtn) {
            installBtn.addEventListener('click', async () => {
                if (!deferredInstallPrompt) return;
                deferredInstallPrompt.prompt();
                const choice = await deferredInstallPrompt.userChoice;
                deferredInstallPrompt = null;
                installBtn.classList.add('hidden');
            });
        }

        // Stop tracking from banner
        const stopBannerBtn = document.getElementById('stopTrackingBtn');
        if (stopBannerBtn) {
            stopBannerBtn.addEventListener('click', () => {
                if (confirm('Stop tracking and cancel trip?')) {
                    TrackingService.cancelTrip();
                }
            });
        }

        // Register a simple service worker (helps PWA install criteria)
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/frontend/sw.js')
                .then(() => console.log('Service worker registered'))
                .catch(() => console.warn('Service worker registration failed'));
        }
    },

    initMapIfNeeded() {
        if (AppState.currentLocation && !AppState.map) {
            setTimeout(() => {
                MapService.initMap();
                document.getElementById('currentLocationDisplay').classList.remove('hidden');
                document.getElementById('currentLocationText').textContent = 
                    `${AppState.currentLocation.lat.toFixed(4)}, ${AppState.currentLocation.lng.toFixed(4)}`;
            }, 500);
        }
    },

    updateMessageStep() {
        if (AppState.destination) {
            document.getElementById('destinationName').textContent = AppState.destination.name;
            document.getElementById('destinationAddress').textContent = AppState.destination.address || 
                `${AppState.destination.lat.toFixed(4)}, ${AppState.destination.lng.toFixed(4)}`;
            document.getElementById('selectedDestinationInfo').classList.remove('hidden');
        }
        ContactManager.renderContactCheckboxes();
    },

    updateUI() {
        // Update radius displays
        document.getElementById('radiusDisplay').textContent = AppState.searchRadius;
        const destRadiusElUI = document.getElementById('destinationRadius');
        if (destRadiusElUI) {
            destRadiusElUI.value = AppState.geofenceRadius;
            document.getElementById('destinationRadiusDisplay').textContent = AppState.geofenceRadius;
        }
    }
};

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => App.init().catch(console.error));
} else {
    App.init().catch(console.error);
}