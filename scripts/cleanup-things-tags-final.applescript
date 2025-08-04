#!/usr/bin/osascript

-- Final cleanup script for Things sync tags
-- Remove synced-from-todoist and synced-to-todoist tags from all tasks

on run argv
    set dry_run to true
    
    -- Check if we should actually remove tags (pass "remove" as argument)
    if (count of argv) > 0 and item 1 of argv is "remove" then
        set dry_run to false
    end if
    
    set tasks_cleaned to 0
    set tags_removed to 0
    
    tell application "Things3"
        -- Process synced-from-todoist tag
        if exists tag "synced-from-todoist" then
            set from_tag to tag "synced-from-todoist"
            set from_tagged_todos to to dos of from_tag
            
            repeat with todo_item in from_tagged_todos
                set tasks_cleaned to tasks_cleaned + 1
                set tags_removed to tags_removed + 1
                
                if not dry_run then
                    -- Remove the tag from this task
                    set current_tags to tag names of todo_item
                    set new_tags to {}
                    
                    repeat with tag_name in current_tags
                        if (tag_name as string) is not "synced-from-todoist" then
                            set end of new_tags to (tag_name as string)
                        end if
                    end repeat
                    
                    set tag names of todo_item to new_tags
                end if
            end repeat
        end if
        
        -- Process synced-to-todoist tag
        if exists tag "synced-to-todoist" then
            set to_tag to tag "synced-to-todoist"
            set to_tagged_todos to to dos of to_tag
            
            repeat with todo_item in to_tagged_todos
                set tasks_cleaned to tasks_cleaned + 1
                set tags_removed to tags_removed + 1
                
                if not dry_run then
                    -- Remove the tag from this task
                    set current_tags to tag names of todo_item
                    set new_tags to {}
                    
                    repeat with tag_name in current_tags
                        if (tag_name as string) is not "synced-to-todoist" then
                            set end of new_tags to (tag_name as string)
                        end if
                    end repeat
                    
                    set tag names of todo_item to new_tags
                end if
            end repeat
        end if
    end tell
    
    if dry_run then
        return "DRY RUN: Found " & tasks_cleaned & " tasks with sync tags (" & tags_removed & " total tags). Run with 'remove' argument to clean them."
    else
        return "Cleaned " & tasks_cleaned & " tasks, removed " & tags_removed & " sync tags from Things."
    end if
end run
