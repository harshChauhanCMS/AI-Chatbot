
import os
from pathlib import Path
from dotenv import load_dotenv
from openai import OpenAI

load_dotenv(Path(__file__).with_name(".env"))

api_key = os.getenv("OPENAI_API_KEY")

if not api_key:
    print("API key not found.")
else:
    try:
        client = OpenAI(api_key=api_key)

        response = client.responses.create(
            model="gpt-4.1-mini",
            input="Reply with exactly: OpenAI API connection successful."
        )

        print("API request successful!")
        print("AI response:", response.output_text)

    except Exception as error:
        print("API request failed.")
        print("Error type:", type(error).__name__)
        print("Error details:", str(error))
