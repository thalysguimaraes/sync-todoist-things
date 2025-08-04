#!/usr/bin/osascript

-- List all tasks in Things inbox with their tags

tell application "Things3"
    set task_list to {}
    
    -- Get all tasks from inbox
    set inbox_todos to to dos of list "Inbox"
    
    repeat with todo_item in inbox_todos
        if status of todo_item is open then
            set task_name to name of todo_item
            set task_tags to tag names of todo_item
            
            -- Build tag string
            set tag_string to ""
            repeat with i from 1 to count of task_tags
                set current_tag to item i of task_tags
                if i = 1 then
                    set tag_string to current_tag as string
                else
                    set tag_string to tag_string & ", " & (current_tag as string)
                end if
            end repeat
            
            if tag_string is "" then
                set tag_string to "(no tags)"
            end if
            
            set task_info to task_name & " | Tags: " & tag_string
            set end of task_list to task_info
        end if
    end repeat
    
    -- Output all tasks
    set output_text to "Things Inbox Tasks (" & (count of task_list) & " total):" & return & return
    repeat with task_info in task_list
        set output_text to output_text & task_info & return
    end repeat
    
    return output_text
end tell
