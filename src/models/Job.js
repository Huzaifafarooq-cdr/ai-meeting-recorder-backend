import mongoose from 'mongoose';

// simple mongo job queue, jobs are claimed with a lease (lockedUntil)
const jobSchema = new mongoose.Schema(
  {
    type: { type: String, default: 'process_recording' },
    recording: { type: mongoose.Schema.Types.ObjectId, ref: 'Recording', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['queued', 'running', 'done', 'failed', 'cancelled'], default: 'queued' },
    fromStage: { type: String, default: 'upload' },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 3 },
    runAt: { type: Date, default: Date.now },
    lockedBy: String,
    lockedUntil: Date,
    lastError: { code: String, message: String },
  },
  { timestamps: true }
);

jobSchema.index({ status: 1, runAt: 1 });
jobSchema.index({ status: 1, lockedUntil: 1 });
// delete after 7 days
jobSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600, partialFilterExpression: { status: { $in: ['done', 'cancelled'] } } });

export const Job = mongoose.model('Job', jobSchema);
