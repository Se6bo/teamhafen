CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  avatar TEXT,
  role TEXT DEFAULT 'member',
  scrum_role TEXT DEFAULT 'developer',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sprints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  number INTEGER NOT NULL,
  goal TEXT,
  description TEXT,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status TEXT DEFAULT 'planned',
  planned_points INTEGER DEFAULT 0,
  project_id INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE backlog_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL,
  priority TEXT DEFAULT 'medium',
  story_points INTEGER DEFAULT 0,
  creator_id INTEGER,
  assignee_id INTEGER,
  sprint_id INTEGER,
  status TEXT DEFAULT 'backlog',
  due_date DATE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (creator_id) REFERENCES users(id),
  FOREIGN KEY (assignee_id) REFERENCES users(id),
  FOREIGN KEY (sprint_id) REFERENCES sprints(id)
);

CREATE TABLE labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  color TEXT DEFAULT '#6B7280'
);

CREATE TABLE task_labels (
  task_id INTEGER,
  label_id INTEGER,
  PRIMARY KEY (task_id, label_id),
  FOREIGN KEY (task_id) REFERENCES backlog_items(id),
  FOREIGN KEY (label_id) REFERENCES labels(id)
);

CREATE TABLE subtasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  completed BOOLEAN DEFAULT FALSE,
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES backlog_items(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES backlog_items(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE doc_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE documentation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT,
  category TEXT DEFAULT 'project',
  author_id INTEGER,
  parent_id INTEGER,
  folder_id INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (author_id) REFERENCES users(id),
  FOREIGN KEY (parent_id) REFERENCES documentation(id),
  FOREIGN KEY (folder_id) REFERENCES doc_folders(id)
);

CREATE TABLE doc_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (doc_id) REFERENCES documentation(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  date DATETIME NOT NULL,
  notes TEXT,
  decisions TEXT,
  open_points TEXT,
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE meeting_participants (
  meeting_id INTEGER,
  user_id INTEGER,
  PRIMARY KEY (meeting_id, user_id),
  FOREIGN KEY (meeting_id) REFERENCES meetings(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE password_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT DEFAULT 'other',
  url TEXT,
  username TEXT,
  password_encrypted BLOB,
  iv BLOB,
  auth_tag BLOB,
  notes TEXT,
  created_by INTEGER,
  updated_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (updated_by) REFERENCES users(id)
);

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT,
  is_read BOOLEAN DEFAULT FALSE,
  link TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  details TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE sprint_burndown (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sprint_id INTEGER NOT NULL,
  date DATE NOT NULL,
  remaining_points REAL NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (sprint_id) REFERENCES sprints(id)
);

CREATE TABLE doc_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mimetype TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (doc_id) REFERENCES documentation(id) ON DELETE CASCADE
);
