#!/usr/bin/osascript

-- Debug a specific task to understand tag structure

tell application "Things3"
    set inbox_todos to to dos of list "Inbox"
    
    repeat with i from 1 to count of inbox_todos
        set todo_item to item i of inbox_todos
        if status of todo_item is open then
            set task_name to name of todo_item
            set tag_names_list to tag names of todo_item
            
            -- Check if this task has any sync-related tags
            repeat with tag_name in tag_names_list
                set tag_str to tag_name as string
                if tag_str contains "synced" then
                    return "Task " & i & ": " & task_name & " has sync tag: '" & tag_str & "'"
                end if
            end repeat
        end if
    end repeat
    
    return "No tasks with sync tags found"
end tell
