import subprocess
import os
import sys

def main():
    # PUT YOUR DOCUMENT ORGANISER FOLDER PATH HERE
    project_path = r"C:/PERSONAL/4SOLUTIONS DOCUMENT ORGANISER/DOCUMENT ORGANISER NODE.JS"
    
    # Check if the path exists
    if not os.path.exists(project_path):
        print(f"Error: Path does not exist: {project_path}")
        print("Please update the project_path variable in the script with the correct path.")
        input("Press Enter to exit...")
        return
    
    # Check if package.json exists
    package_json = os.path.join(project_path, "package.json")
    if not os.path.exists(package_json):
        print(f"Error: package.json not found in {project_path}")
        print("Make sure this is the correct project folder.")
        input("Press Enter to exit...")
        return
    
    try:
        # Change to the project directory and run npm start
        os.chdir(project_path)
        
        if sys.platform.startswith('win'):
            # Windows - open in new command prompt window
            subprocess.Popen(['cmd', '/c', 'start', 'cmd', '/k', 'npm run start'], 
                           shell=True)
        else:
            # macOS/Linux - open in new terminal
            subprocess.Popen(['gnome-terminal', '--', 'bash', '-c', 'npm run start; exec bash'], 
                           shell=False)
        
        print("Document Organiser started successfully!")
        
    except Exception as e:
        print(f"Error starting Document Organiser: {e}")
        input("Press Enter to exit...")

if __name__ == "__main__":
    main()