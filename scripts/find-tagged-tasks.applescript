#!/usr/bin/osascript

-- Find tasks that have specific sync tags

tell application "Things3"
    set sync_tag_names to {"synced-from-todoist", "synced-to-todoist"}
    set found_tasks to {}
    
    repeat with sync_tag_name in sync_tag_names
        try
            -- Check if the tag exists
            if exists tag sync_tag_name then
                set sync_tag to tag sync_tag_name
                set tagged_todos to to dos of sync_tag
                
                set tag_info to "Tag '" & sync_tag_name & "' has " & (count of tagged_todos) & " tasks:"
                set end of found_tasks to tag_info
                
                -- List first few tasks with this tag
                set list_count to 5
                if (count of tagged_todos) < list_count then
                    set list_count to count of tagged_todos
                end if
                
                repeat with i from 1 to list_count
                    set todo_item to item i of tagged_todos
                    set task_name to name of todo_item
                    set task_status to status of todo_item
                    set task_info to "  " & task_name & " (status: " & task_status & ")"
                    set end of found_tasks to task_info
                end repeat
                
                if (count of tagged_todos) > list_count then
                    set more_info to "  ... and " & ((count of tagged_todos) - list_count) & " more"
                    set end of found_tasks to more_info
                end if
                
            else
                set tag_info to "Tag '" & sync_tag_name & "' does not exist"
                set end of found_tasks to tag_info
            end if
        on error err_msg
            set error_info to "Error checking tag '" & sync_tag_name & "': " & err_msg
            set end of found_tasks to error_info
        end try
        
        set end of found_tasks to ""
    end repeat
    
    -- Build output
    set output_text to ""
    repeat with task_info in found_tasks
        set output_text to output_text & task_info & return
    end repeat
    
    return output_text
end tell
