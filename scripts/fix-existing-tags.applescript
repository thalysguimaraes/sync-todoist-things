#!/usr/bin/osascript

-- Fix existing tasks by adding the correct sync tag
-- This is a one-time script to fix tasks that were synced before the tag fix

on run
    set fixed_count to 0
    set checked_count to 0
    
    tell application "Things3"
        -- Create the tag if it doesn't exist
        if not (exists tag "synced-to-todoist") then
            make new tag with properties {name:"synced-to-todoist"}
        end if
        
        -- Get all todos from the Inbox
        set inbox_todos to to dos of list "Inbox"
        
        repeat with todo_item in inbox_todos
            set checked_count to checked_count + 1
            set todo_tags to tag names of todo_item
            
            -- Check if task has neither sync tag but has a todoist ID in notes
            if "synced-from-todoist" is not in todo_tags and "synced-to-todoist" is not in todo_tags then
                set todo_notes to notes of todo_item
                if todo_notes is not missing value then
                    -- Check if it has a todoist ID (meaning it was synced)
                    if todo_notes contains "[todoist-id:" then
                        -- Add the synced-to-todoist tag
                        set tag names of todo_item to todo_tags & "synced-to-todoist"
                        set fixed_count to fixed_count + 1
                    end if
                end if
            end if
        end repeat
    end tell
    
    return "Checked " & checked_count & " tasks, fixed " & fixed_count & " tasks with missing tags"
end run