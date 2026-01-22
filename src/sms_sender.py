from twilio.rest import Client
from dotenv import load_dotenv
import os
import logging

load_dotenv()

logger = logging.getLogger(__name__)

# Load from environment variables
ACCOUNT_SID = os.getenv("ACCOUNT_SID")
AUTH_TOKEN = os.getenv("AUTH_TOKEN")
TWILIO_NUMBER = os.getenv("TWILIO_NUMBER")

# Validate environment variables
if not all([ACCOUNT_SID, AUTH_TOKEN, TWILIO_NUMBER]):
    logger.error("Missing Twilio credentials in environment variables")
    raise ValueError("Twilio credentials not configured. Check your .env file")

# Initialize Twilio client
try:
    client = Client(ACCOUNT_SID, AUTH_TOKEN)
    logger.info("Twilio client initialized successfully")
except Exception as e:
    logger.error(f"Failed to initialize Twilio client: {e}")
    raise

def send_sms(to_number: str, message_body: str):
    """
    Send SMS using Twilio
    
    Args:
        to_number: Recipient phone number (E.164 format, e.g., +1234567890)
        message_body: Message content
        
    Returns:
        message.sid: Twilio message SID
        
    Raises:
        Exception: If SMS sending fails
    """
    try:
        # Validate phone number format
        if not to_number.startswith('+'):
            logger.warning(f"Phone number {to_number} doesn't start with +. Attempting to send anyway.")
        
        # Send message
        message = client.messages.create(
            body=message_body,
            from_=TWILIO_NUMBER,
            to=to_number
        )
        
        logger.info(f"SMS sent successfully to {to_number}. SID: {message.sid}")
        return message.sid
    
    except Exception as e:
        logger.error(f"Failed to send SMS to {to_number}: {e}")
        raise Exception(f"SMS sending failed: {str(e)}")

def validate_phone_number(phone: str) -> bool:
    """
    Basic phone number validation
    
    Args:
        phone: Phone number to validate
        
    Returns:
        bool: True if valid format
    """
    # Remove spaces and dashes
    cleaned = phone.replace(" ", "").replace("-", "")
    
    # Check if starts with + and has 10-15 digits
    if cleaned.startswith('+') and len(cleaned) >= 11 and len(cleaned) <= 16:
        return cleaned[1:].isdigit()
    
    return False