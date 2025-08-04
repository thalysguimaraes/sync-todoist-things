#!/usr/bin/osascript

-- Remove sync tags from Things tasks
-- Removes 'synced-from-todoist' and 'synced-to-todoist' tags

on run argv
    set dry_run to true
    
    -- Check if we should actually remove tags (pass "remove" as argument)
    if (count of argv) > 0 and item 1 of argv is "remove" then
        set dry_run to false
    end if
    
    set tasks_processed to 0
    set tasks_cleaned to 0
    set tags_removed to 0
    
    tell application "Things3"
        -- Get all tasks from inbox
        set inbox_todos to to dos of list "Inbox"
        
        repeat with todo_item in inbox_todos
            if status of todo_item is open then
                set tasks_processed to tasks_processed + 1
                set task_name to name of todo_item
                set task_tags to tags of todo_item
                
                -- Check if task has sync tags
                set has_sync_tags to false
                set clean_tags to {}
                
                repeat with current_tag in task_tags
                    set tag_name to name of current_tag
                    if tag_name is "synced-from-todoist" or tag_name is "synced-to-todoist" then
                        set has_sync_tags to true
                        set tags_removed to tags_removed + 1
                    else
                        set end of clean_tags to current_tag
                    end if
                end repeat
                
                -- Remove sync tags if found
                if has_sync_tags then
                    set tasks_cleaned to tasks_cleaned + 1
                    
                    if not dry_run then
                        -- Build list of clean tag names
                        set clean_tag_names to {}
                        repeat with clean_tag in clean_tags
                            set tag_name to name of clean_tag
                            set end of clean_tag_names to tag_name
                        end repeat
                        
                        -- Set the clean tag names
                        set tag names of todo_item to clean_tag_names
                    end if
                end if
            end if
        end repeat
    end tell
    
    if dry_run then
        return "DRY RUN: Processed " & tasks_processed & " tasks, found " & tasks_cleaned & " tasks with sync tags (" & tags_removed & " sync tags total). Run with 'remove' argument to clean them."
    else
        return "Processed " & tasks_processed & " tasks, cleaned " & tasks_cleaned & " tasks, removed " & tags_removed & " sync tags."
    end if
end run
