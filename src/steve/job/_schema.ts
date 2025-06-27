export function _schema() {}
// id SERIAL PRIMARY KEY,
//   type VARCHAR(100) NOT NULL,
//   payload JSONB,
//   status VARCHAR(20) DEFAULT 'pending', -- pending, running, completed, failed
//   attempts INTEGER DEFAULT 0,
//   max_attempts INTEGER DEFAULT 3,
//   created_at TIMESTAMP DEFAULT NOW(),
//   updated_at TIMESTAMP DEFAULT NOW(),
//   started_at TIMESTAMP,
//   completed_at TIMESTAMP,
//   run_at TIMESTAMP DEFAULT NOW() -- supports scheduling with backoff
