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
            set todoTitle to my normalize_title(name of aTodo)
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
    
    return "Deleted " & deletedCount & " duplicate tasks"
end run

-- Normalize a title: lowercase, trim, collapse whitespace
on normalize_title(input_title)
    if input_title is missing value then return ""
    set theTitle to input_title as string
    try
        set normalized to do shell script "printf %s " & quoted form of theTitle & " | tr '[:upper:]' '[:lower:]' | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//'"
        return normalized
    on error
        return theTitle
    end try
end normalize_title