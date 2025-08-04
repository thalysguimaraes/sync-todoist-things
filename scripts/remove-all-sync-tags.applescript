#!/usr/bin/osascript

-- Remove sync tags from all Things tasks (inbox and projects)

tell application "Things3"
    set tasks_processed to 0
    set tags_removed to 0
    
    -- Process inbox tasks
    set inbox_todos to to dos of list "Inbox"
    
    repeat with todo_item in inbox_todos
        if status of todo_item is open then
            set tasks_processed to tasks_processed + 1
            
            -- Get current tag names as a list
            set current_tag_names to tag names of todo_item
            set new_tag_names to {}
            set removed_any to false
            
            -- Filter out sync tags
            repeat with tag_name in current_tag_names
                set tag_str to tag_name as string
                if tag_str is not "synced-from-todoist" and tag_str is not "synced-to-todoist" and tag_str is not "" then
                    set end of new_tag_names to tag_str
                else if tag_str is "synced-from-todoist" or tag_str is "synced-to-todoist" then
                    set removed_any to true
                    set tags_removed to tags_removed + 1
                end if
            end repeat
            
            -- Update tags if we removed any
            if removed_any then
                set tag names of todo_item to new_tag_names
            end if
        end if
    end repeat
    
    -- Process project tasks
    repeat with aProject in projects
        repeat with todo_item in to dos of aProject
            if status of todo_item is open then
                set tasks_processed to tasks_processed + 1
                
                -- Get current tag names as a list
                set current_tag_names to tag names of todo_item
                set new_tag_names to {}
                set removed_any to false
                
                -- Filter out sync tags
                repeat with tag_name in current_tag_names
                    set tag_str to tag_name as string
                    if tag_str is not "synced-from-todoist" and tag_str is not "synced-to-todoist" and tag_str is not "" then
                        set end of new_tag_names to tag_str
                    else if tag_str is "synced-from-todoist" or tag_str is "synced-to-todoist" then
                        set removed_any to true
                        set tags_removed to tags_removed + 1
                    end if
                end repeat
                
                -- Update tags if we removed any
                if removed_any then
                    set tag names of todo_item to new_tag_names
                end if
            end if
        end repeat
    end repeat
    
    return "Processed " & tasks_processed & " tasks, removed " & tags_removed & " sync tags."
end tell
