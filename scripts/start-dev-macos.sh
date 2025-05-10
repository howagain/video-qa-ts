#!/bin/bash

# Get the absolute path to the project directory
# This ensures commands run in the correct context even if the script is called from elsewhere
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "Project directory: ${PROJECT_DIR}"
echo "Attempting to open new Terminal tabs..."

# Command to start the database in a new terminal tab
osascript <<EOF
tell application "Terminal"
    activate
    if not (exists window 1) then reopen
    tell application "System Events" to keystroke "t" using command down
    delay 0.5 -- Give tab time to open
    do script "echo 'Changing to project directory and starting database...'; cd \"${PROJECT_DIR}\" && bun run dev:db-start" in window 1
end tell
EOF

# Give it a moment for the first tab to initialize and for you to see its output
sleep 2

# Command to start the dev servers in another new terminal tab
osascript <<EOF
tell application "Terminal"
    activate
    if not (exists window 1) then reopen -- Should not be needed if first one worked, but good practice
    tell application "System Events" to keystroke "t" using command down
    delay 0.5
    do script "echo 'Changing to project directory and starting app servers...'; cd \"${PROJECT_DIR}\" && bun dev" in window 1
end tell
EOF

echo ""
echo "Launched database and app servers in new Terminal tabs."
echo "Please check your Terminal application."
echo "Note: You might need to grant scripting permissions if prompted (System Settings > Privacy & Security > Automation)." 