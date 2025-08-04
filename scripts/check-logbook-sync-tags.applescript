#!/usr/bin/osascript

-- Check for sync tags in completed tasks (Logbook)

tell application "Things3"
    set sync_tagged_count to 0
    set recent_sync_tasks to {}
    
    -- Get recent completed tasks from logbook
    set logbook_todos to to dos of list "Logbook"
    
    -- Check the last 20 completed tasks
    set check_count to 20
    if (count of logbook_todos) < check_count then
        set check_count to count of logbook_todos
    end if
    
    repeat with i from 1 to check_count
        set todo_item to item i of logbook_todos
        set task_name to name of todo_item
        set tag_names_list to tag names of todo_item
        
        -- Check for sync tags
        repeat with tag_name in tag_names_list
            set tag_str to tag_name as string
            if tag_str contains "synced" then
                set sync_tagged_count to sync_tagged_count + 1
                set task_info to task_name & " (tag: " & tag_str & ")"
                set end of recent_sync_tasks to task_info
            end if
        end repeat
    end repeat
    
    set output_text to "Checked " & check_count & " recent completed tasks" & return
    set output_text to output_text & "Found " & sync_tagged_count & " with sync tags:" & return
    
    repeat with task_info in recent_sync_tasks
        set output_text to output_text & "  " & task_info & return
    end repeat
    
    return output_text
end tell
