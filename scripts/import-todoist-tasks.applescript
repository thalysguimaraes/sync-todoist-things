#!/usr/bin/osascript

-- Import tasks from Todoist with duplicate prevention
-- Expects JSON array of tasks as argument

on run argv
    if (count of argv) is 0 then
        return "No tasks provided"
    end if
    
    set jsonString to item 1 of argv
    set imported_count to 0
    set skipped_count to 0
    
    tell application "Things3"
        -- Parse the JSON tasks
        set todoist_tasks to my parseTodoistTasks(jsonString)
        
        -- Get existing inbox task titles (normalized)
        set existing_titles to {}
        set inbox_todos to to dos of list "Inbox"
        repeat with todo_item in inbox_todos
            if status of todo_item is open then
                set end of existing_titles to my normalize_title(name of todo_item)
            end if
        end repeat
        
        -- Import non-duplicate tasks
        repeat with task_data in todoist_tasks
            set task_title to title of task_data
            set task_notes to notes of task_data
            set task_due to due of task_data
            set todoist_id to todoistId of task_data
            set normalized_title to my normalize_title(task_title)
            
            -- Check if task already exists
            if normalized_title is not in existing_titles then
                -- Create new task
                set new_todo to make new to do with properties {name:task_title}
                move new_todo to list "Inbox"
                
                -- Add notes with Todoist ID
                if task_notes is not "" then
                    set notes of new_todo to task_notes & return & return & "[todoist-id:" & todoist_id & "]"
                else
                    set notes of new_todo to "[todoist-id:" & todoist_id & "]"
                end if
                
                -- Set due date if provided
                if task_due is not "null" and task_due is not "" then
                    try
                        set due date of new_todo to date task_due
                    end try
                end if
                
                -- Add synced tag
                if not (exists tag "synced-from-todoist") then
                    make new tag with properties {name:"synced-from-todoist"}
                end if
                set tag names of new_todo to {"synced-from-todoist"}
                
                set imported_count to imported_count + 1
                set end of existing_titles to normalized_title -- Add to existing to prevent duplicates in same run
            else
                set skipped_count to skipped_count + 1
            end if
        end repeat
    end tell
    
    return "Imported " & imported_count & " tasks, skipped " & skipped_count & " existing"
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

-- Parse JSON array of Todoist tasks
on parseTodoistTasks(jsonStr)
    set tasks to {}
    
    -- Remove brackets and split by },{
    if jsonStr starts with "[" then set jsonStr to text 2 thru -2 of jsonStr
    set AppleScript's text item delimiters to "},{"
    set jsonItems to text items of jsonStr
    set AppleScript's text item delimiters to ""
    
    repeat with itemStr in jsonItems
        -- Clean up the item
        if itemStr starts with "{" then set itemStr to text 2 thru -1 of itemStr
        if itemStr ends with "}" then set itemStr to text 1 thru -2 of itemStr
        
        -- Extract fields
        set task_title to my extractValue(itemStr, "title")
        set task_notes to my extractValue(itemStr, "notes")
        -- Clean up escaped quotes in notes
        if task_notes is "\\\"\\\"" then set task_notes to ""
        if task_notes starts with "\\\"" then set task_notes to text 3 thru -3 of task_notes
        set task_due to my extractValue(itemStr, "due")
        set todoist_id to my extractValue(itemStr, "id")
        
        if task_title is not "" then
            set end of tasks to {title:task_title, notes:task_notes, due:task_due, todoistId:todoist_id}
        end if
    end repeat
    
    return tasks
end parseTodoistTasks

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
    
    -- Try without quotes (for null values)
    set searchPattern to "\"" & key & "\":"
    try
        set startPos to offset of searchPattern in str
        if startPos > 0 then
            set valueStart to startPos + (length of searchPattern)
            set remainingStr to text valueStart thru -1 of str
            set endPos to offset of "," in remainingStr
            if endPos = 0 then set endPos to (length of remainingStr) + 1
            set value to text 1 thru (endPos - 1) of remainingStr
            if value is "null" then return "null"
            return value
        end if
    end try
    
    return ""
end extractValue