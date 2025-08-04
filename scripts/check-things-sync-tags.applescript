#!/usr/bin/osascript

-- Simple script to check for sync tags in Things

tell application "Things3"
    set tasks_with_sync_tags to 0
    set sync_tag_details to {}
    
    -- Get all tasks from inbox
    set inbox_todos to to dos of list "Inbox"
    
    repeat with todo_item in inbox_todos
        if status of todo_item is open then
            set task_name to name of todo_item
            set task_id to id of todo_item
            set task_tags to tag names of todo_item
            
            -- Convert to list and check each tag
            set has_sync_tag to false
            set found_sync_tags to ""
            
            repeat with i from 1 to count of task_tags
                set current_tag to item i of task_tags
                if (current_tag as string) contains "synced" then
                    set has_sync_tag to true
                    if found_sync_tags is "" then
                        set found_sync_tags to current_tag as string
                    else
                        set found_sync_tags to found_sync_tags & ", " & (current_tag as string)
                    end if
                end if
            end repeat
            
            if has_sync_tag then
                set tasks_with_sync_tags to tasks_with_sync_tags + 1
                set task_detail to "Task: " & task_name & " | Tags: " & found_sync_tags
                set end of sync_tag_details to task_detail
            end if
        end if
    end repeat
    
    -- Output results
    set output_text to "Total inbox tasks: " & (count of inbox_todos) & return
    set output_text to output_text & "Tasks with sync tags: " & tasks_with_sync_tags & return
    
    if tasks_with_sync_tags > 0 then
        set output_text to output_text & return & "Details:" & return
        repeat with detail in sync_tag_details
            set output_text to output_text & "  " & detail & return
        end repeat
    else
        set output_text to output_text & return & "No sync tags found!"
    end if
    
    return output_text
end tell
