#!/usr/bin/osascript

-- Add "synced-from-todoist" tag to tasks in Things
-- This prevents them from being synced back to Todoist

on run argv
    -- Expect task titles as arguments
    if (count of argv) is 0 then
        return "No tasks provided"
    end if
    
    set tagged_count to 0
    
    tell application "Things3"
        repeat with task_title in argv
            try
                -- Find todos in inbox with matching title
                set matching_todos to (to dos of list "Inbox" whose name is (task_title as string))
                
                repeat with todo_item in matching_todos
                    -- Check if already has the tag
                    set existing_tags to tag names of todo_item
                    if "synced-from-todoist" is not in existing_tags then
                        -- Create tag if it doesn't exist
                        if not (exists tag "synced-from-todoist") then
                            make new tag with properties {name:"synced-from-todoist"}
                        end if
                        
                        -- Add tag to task
                        set tag names of todo_item to existing_tags & "synced-from-todoist"
                        set tagged_count to tagged_count + 1
                    end if
                end repeat
            on error errMsg
                -- Continue with next task if error
            end try
        end repeat
    end tell
    
    return "Tagged " & tagged_count & " tasks"
end run