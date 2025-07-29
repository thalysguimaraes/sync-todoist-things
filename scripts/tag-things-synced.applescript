#!/usr/bin/osascript

-- Add "synced-from-todoist" tag to tasks in Things
-- This prevents them from being synced back to Todoist
-- Expects JSON format: [{"thingsId": "xxx", "todoistId": "yyy"}, ...]

on run argv
    -- Expect JSON string with task mappings
    if (count of argv) is 0 then
        return "No tasks provided"
    end if
    
    set jsonString to item 1 of argv
    
    set tagged_count to 0
    set updated_count to 0
    
    tell application "Things3"
        -- Parse the JSON manually (simple parsing for array of objects)
        set taskMappings to my parseTaskMappings(jsonString)
        
        repeat with mapping in taskMappings
            set thingsId to thingsId of mapping
            set todoistId to todoistId of mapping
            
            try
                -- Find todo by ID
                set targetTodo to to do id thingsId
                
                if targetTodo is not missing value then
                    -- Check if already has the tag
                    set existing_tags to tag names of targetTodo
                    if "synced-from-todoist" is not in existing_tags then
                        -- Create tag if it doesn't exist
                        if not (exists tag "synced-from-todoist") then
                            make new tag with properties {name:"synced-from-todoist"}
                        end if
                        
                        -- Add tag to task
                        set tag names of targetTodo to existing_tags & "synced-from-todoist"
                        set tagged_count to tagged_count + 1
                    end if
                    
                    -- Update notes with Todoist ID if not already present
                    set current_notes to notes of targetTodo
                    if current_notes is missing value then set current_notes to ""
                    
                    if current_notes does not contain "[todoist-id:" then
                        set new_notes to current_notes & "\n\n[todoist-id:" & todoistId & "]"
                        set notes of targetTodo to new_notes
                        set updated_count to updated_count + 1
                    end if
                end if
            on error errMsg
                -- Continue with next task if error
            end try
        end repeat
    end tell
    
    return "Tagged " & tagged_count & " tasks, updated " & updated_count & " with Todoist IDs"
end run

-- Helper function to parse JSON task mappings
-- Expects format: [{"thingsId":"xxx","todoistId":"yyy"},...]
on parseTaskMappings(jsonStr)
    set mappings to {}
    
    -- Remove brackets and split by },{
    set jsonStr to text 2 thru -2 of jsonStr -- Remove [ and ]
    set AppleScript's text item delimiters to "},{" 
    set items to text items of jsonStr
    set AppleScript's text item delimiters to ""
    
    repeat with itemStr in items
        -- Clean up the item
        if itemStr starts with "{" then
            set itemStr to text 2 thru -1 of itemStr
        end if
        if itemStr ends with "}" then
            set itemStr to text 1 thru -2 of itemStr
        end if
        
        -- Extract thingsId and todoistId
        set thingsId to my extractValue(itemStr, "thingsId")
        set todoistId to my extractValue(itemStr, "todoistId")
        
        if thingsId is not "" and todoistId is not "" then
            set end of mappings to {thingsId:thingsId, todoistId:todoistId}
        end if
    end repeat
    
    return mappings
end parseTaskMappings

-- Extract value for a key from JSON-like string
on extractValue(str, key)
    set searchPattern to "\"" & key & "\":\""
    set patternLen to length of searchPattern
    
    try
        set startPos to offset of searchPattern in str
        if startPos > 0 then
            set valueStart to startPos + patternLen
            set remainingStr to text valueStart thru -1 of str
            set endPos to offset of "\"" in remainingStr
            if endPos > 0 then
                return text 1 thru (endPos - 1) of remainingStr
            end if
        end if
    end try
    
    return ""
end extractValue