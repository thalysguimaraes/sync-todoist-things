#!/usr/bin/osascript

-- Find duplicate tasks in Things inbox

on run
    set duplicates to {}
    set task_map to {}
    
    tell application "Things3"
        -- Get all todos from the Inbox
        set inbox_todos to to dos of list "Inbox"
        
        -- Build a map of task names to find duplicates
        repeat with todo_item in inbox_todos
            if status of todo_item is open then
                set task_name to name of todo_item
                set task_id to id of todo_item
                set task_tags to tag names of todo_item
                
                -- Create a key for the task
                set task_key to task_name
                
                -- Check if we've seen this task before
                set found to false
                repeat with i from 1 to count of task_map
                    if task_key = task_key of item i of task_map then
                        -- Found a duplicate
                        set found to true
                        set duplicate_info to {original_id:(task_id of item i of task_map), duplicate_id:task_id, name:task_name, original_tags:(task_tags of item i of task_map), duplicate_tags:task_tags}
                        set end of duplicates to duplicate_info
                        exit repeat
                    end if
                end repeat
                
                if not found then
                    -- First occurrence of this task
                    set end of task_map to {task_key:task_key, task_id:task_id, task_tags:task_tags}
                end if
            end if
        end repeat
    end tell
    
    -- Output duplicates as JSON
    set json_output to "["
    set first_item to true
    
    repeat with dup in duplicates
        if not first_item then
            set json_output to json_output & ","
        end if
        set first_item to false
        
        set json_output to json_output & "{" & ¬
            "\"name\":\"" & (name of dup) & "\"," & ¬
            "\"original_id\":\"" & (original_id of dup) & "\"," & ¬
            "\"duplicate_id\":\"" & (duplicate_id of dup) & "\"," & ¬
            "\"original_has_synced_tag\":" & (("synced-to-todoist" is in (original_tags of dup)) as string) & "," & ¬
            "\"duplicate_has_synced_tag\":" & (("synced-to-todoist" is in (duplicate_tags of dup)) as string) & ¬
            "}"
    end repeat
    
    set json_output to json_output & "]"
    
    return json_output
end run