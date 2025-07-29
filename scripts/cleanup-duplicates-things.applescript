#!/usr/bin/osascript

-- Clean up duplicate tasks in Things inbox
-- Keeps the first occurrence and moves duplicates to trash

on run argv
    set dry_run to true
    
    -- Check if we should actually delete (pass "delete" as argument)
    if (count of argv) > 0 and item 1 of argv is "delete" then
        set dry_run to false
    end if
    
    set duplicates_found to 0
    set duplicates_removed to 0
    set task_map to {}
    
    tell application "Things3"
        -- Get all todos from the Inbox
        set inbox_todos to to dos of list "Inbox"
        
        -- Process each task
        repeat with todo_item in inbox_todos
            if status of todo_item is open then
                set task_name to name of todo_item
                set task_id to id of todo_item
                set task_created to creation date of todo_item
                
                -- Check if we've seen this task before
                set found to false
                set found_index to 0
                
                repeat with i from 1 to count of task_map
                    if task_name = (task_name of item i of task_map) then
                        set found to true
                        set found_index to i
                        exit repeat
                    end if
                end repeat
                
                if found then
                    -- This is a duplicate
                    set duplicates_found to duplicates_found + 1
                    set original_created to task_created of item found_index of task_map
                    
                    -- Determine which one to keep (keep the older one)
                    if task_created > original_created then
                        -- Current task is newer, delete it
                        if not dry_run then
                            move todo_item to list "Trash"
                            set duplicates_removed to duplicates_removed + 1
                        end if
                    else
                        -- Current task is older, delete the previous one and update our map
                        if not dry_run then
                            set original_id to task_id of item found_index of task_map
                            set original_todo to to do id original_id
                            move original_todo to list "Trash"
                            set duplicates_removed to duplicates_removed + 1
                        end if
                        -- Update the map with the current (older) task
                        set task_id of item found_index of task_map to task_id
                        set task_created of item found_index of task_map to task_created
                    end if
                else
                    -- First occurrence of this task
                    set end of task_map to {task_name:task_name, task_id:task_id, task_created:task_created}
                end if
            end if
        end repeat
    end tell
    
    if dry_run then
        return "DRY RUN: Found " & duplicates_found & " duplicate(s). Run with 'delete' argument to remove them."
    else
        return "Found " & duplicates_found & " duplicate(s), removed " & duplicates_removed & " task(s)"
    end if
end run