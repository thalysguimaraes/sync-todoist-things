#!/usr/bin/osascript

-- Remove duplicate tasks from Things inbox
-- Keeps the original and removes all duplicates

on run
    tell application "Things3"
        -- Get all to-dos in the Inbox
        set inboxTodos to to dos of list "Inbox"
        set deletedCount to 0
        set processedTitles to {}
        
        -- Process each to-do
        repeat with aTodo in inboxTodos
            set todoTitle to name of aTodo
            set todoId to id of aTodo
            
            -- Check if we've seen this title before
            if processedTitles contains todoTitle then
                -- This is a duplicate, delete it
                try
                    move aTodo to list "Trash"
                    set deletedCount to deletedCount + 1
                    log "Deleted duplicate: " & todoTitle & " (ID: " & todoId & ")"
                end try
            else
                -- First occurrence, keep it
                set end of processedTitles to todoTitle
                log "Keeping original: " & todoTitle & " (ID: " & todoId & ")"
            end if
        end repeat
        
        -- Empty trash to permanently delete
        if deletedCount > 0 then
            empty trash
        end if
        
        return "Deleted " & deletedCount & " duplicate tasks"
    end tell
end run