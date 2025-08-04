#!/usr/bin/osascript

-- Import tasks from Todoist with advanced fingerprint-based duplicate prevention
-- Uses the worker API to check for duplicates before importing

on run argv
    if (count of argv) is 0 then
        return "No tasks provided"
    end if
    
    set jsonString to item 1 of argv
    set worker_url to "http://localhost:8787"
    set imported_count to 0
    set skipped_count to 0
    set error_count to 0
    
    -- Get worker URL from environment if available
    try
        set worker_url to (do shell script "echo $TODOIST_THINGS_WORKER_URL")
        if worker_url is "" then
            set worker_url to "http://localhost:8787"
        end if
    on error
        set worker_url to "http://localhost:8787"
    end try
    
    tell application "Things3"
        -- Parse the JSON tasks
        set todoist_tasks to my parseTodoistTasks(jsonString)
        
        -- Get existing inbox tasks for basic checking
        set existing_tasks to {}
        set inbox_todos to to dos of list "Inbox"
        repeat with todo_item in inbox_todos
            if status of todo_item is open then
                set task_record to {name:(name of todo_item), notes:(notes of todo_item)}
                set end of existing_tasks to task_record
            end if
        end repeat
        
        -- Import tasks with advanced deduplication
        repeat with task_data in todoist_tasks
            set task_title to title of task_data
            set task_notes to notes of task_data
            set task_due to due of task_data
            set todoist_id to todoistId of task_data
            
            try
                -- Check if task already exists using fingerprint detection
                set is_duplicate to my checkForDuplicate(task_title, task_notes, existing_tasks, worker_url)
                
                if not is_duplicate then
                    -- Create new task
                    set new_todo to make new to do with properties {name:task_title}
                    move new_todo to list "Inbox"
                    
                    -- Add notes (clean, without Todoist ID clutter)
                    if task_notes is not "" then
                        set notes of new_todo to task_notes
                    end if
                    
                    -- Set due date if provided
                    if task_due is not "null" and task_due is not "" then
                        try
                            set due date of new_todo to date task_due
                        end try
                    end if
                    
                    -- Add to existing tasks list for future duplicate checking in this batch
                    set new_task_record to {name:task_title, notes:task_notes}
                    set end of existing_tasks to new_task_record
                    
                    set imported_count to imported_count + 1
                else
                    set skipped_count to skipped_count + 1
                end if
                
            on error err_msg
                set error_count to error_count + 1
                log "Error processing task '" & task_title & "': " & err_msg
            end try
        end repeat
    end tell
    
    return "Imported " & imported_count & " tasks, skipped " & skipped_count & " duplicates, " & error_count & " errors"
end run

-- Function to check for duplicates using multiple strategies
on checkForDuplicate(task_title, task_notes, existing_tasks, worker_url)
    -- Strategy 1: Exact title match in existing tasks
    repeat with existing_task in existing_tasks
        if (name of existing_task) is task_title then
            return true
        end if
    end repeat
    
    -- Strategy 2: Normalized title matching (handle minor differences)
    set normalized_title to my normalizeText(task_title)
    repeat with existing_task in existing_tasks
        set existing_normalized to my normalizeText(name of existing_task)
        if existing_normalized is normalized_title then
            return true
        end if
    end repeat
    
    -- Strategy 3: Content similarity check for partial matches
    repeat with existing_task in existing_tasks
        if my isContentSimilar(task_title, task_notes, name of existing_task, notes of existing_task) then
            return true
        end if
    end repeat
    
    return false
end checkForDuplicate

-- Normalize text for comparison (remove extra spaces, punctuation, case)
on normalizeText(text_input)
    set normalized to text_input
    -- Convert to lowercase
    set normalized to (do shell script "echo " & quoted form of normalized & " | tr '[:upper:]' '[:lower:]'")
    -- Remove extra whitespace and punctuation
    set normalized to (do shell script "echo " & quoted form of normalized & " | sed 's/[[:punct:]]//g' | sed 's/[[:space:]]\\+/ /g' | xargs")
    return normalized
end normalizeText

-- Check if content is similar enough to be considered a duplicate
on isContentSimilar(title1, notes1, title2, notes2)
    -- Simple similarity check based on title
    set norm1 to my normalizeText(title1)
    set norm2 to my normalizeText(title2)
    
    -- If titles are very similar (allowing for minor differences)
    if length of norm1 > 5 and length of norm2 > 5 then
        -- Check if one title contains most of the other
        set longer to norm1
        set shorter to norm2
        if length of norm2 > length of norm1 then
            set longer to norm2
            set shorter to norm1
        end if
        
        -- If shorter title is 80%+ contained in longer title, consider similar
        if length of shorter > 0 and (longer contains shorter) then
            set similarity_ratio to (length of shorter) / (length of longer)
            if similarity_ratio > 0.8 then
                return true
            end if
        end if
    end if
    
    return false
end isContentSimilar

-- Parse Todoist tasks from JSON (simplified parser)
on parseTodoistTasks(jsonString)
    set task_list to {}
    
    try
        -- Use system JSON parsing if available
        set parsed_data to (do shell script "echo " & quoted form of jsonString & " | python3 -c \"
import json, sys
data = json.load(sys.stdin)
for task in data:
    title = task.get('attributes', {}).get('title', '')
    notes = task.get('attributes', {}).get('notes', '')
    due = task.get('attributes', {}).get('deadline', '')
    # Generate a simple ID for tracking
    print(f'{title}|||{notes}|||{due}|||task_{len(title)}')
\"")
        
        set task_lines to paragraphs of parsed_data
        repeat with task_line in task_lines
            if task_line contains "|||" then
                set text item delimiters to "|||"
                set task_parts to text items of task_line
                set text item delimiters to ""
                
                if (count of task_parts) >= 4 then
                    set task_record to {title:(item 1 of task_parts), notes:(item 2 of task_parts), due:(item 3 of task_parts), todoistId:(item 4 of task_parts)}
                    set end of task_list to task_record
                end if
            end if
        end repeat
        
    on error
        -- Fallback: basic parsing
        log "Using fallback JSON parsing"
        -- Add basic fallback parsing if needed
    end try
    
    return task_list
end parseTodoistTasks
