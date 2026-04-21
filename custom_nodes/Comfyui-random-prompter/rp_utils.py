import os
import json

# Get the absolute path of the directory where this utils.py file is located
BASE_PATH = os.path.dirname(os.path.abspath(__file__))
DATA_PATH = os.path.join(BASE_PATH, "data")

def get_json_files(subfolder_name):
    """
    Scans the specific data subfolder (e.g., 'body_build') 
    and returns a list of .json filenames.
    """
    target_folder = os.path.join(DATA_PATH, subfolder_name)
    
    # Create the folder if it doesn't exist yet
    if not os.path.exists(target_folder):
        os.makedirs(target_folder)
        return ["No files found"]

    # List all .json files
    files = [f for f in os.listdir(target_folder) if f.endswith('.json')]
    
    if not files:
        return ["No files found"]
        
    return files

def load_json_data(subfolder_name, file_name):
    """
    Reads the content of a specific JSON file.
    """
    file_path = os.path.join(DATA_PATH, subfolder_name, file_name)
    
    if not os.path.exists(file_path):
        print(f"Error: File {file_path} not found.")
        return {}
        
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data
    except Exception as e:
        print(f"Error loading JSON: {e}")
        return {}