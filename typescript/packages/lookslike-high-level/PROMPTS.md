- prepopulate the system with messages / data
- show ingestion from external sources (email and clipper)
- view collection contents
- search for data across collections
- generate a view of the data
- generate an image from the data
- save data to a collection from within the system
    - new message for the message view, go back to see it

---

{
  "inbox": [
    {
      "id": "1",
      "from": {
        "name": "John Smith",
        "email": "john.smith@company.com"
      },
      "to": [
        {
          "name": "Sarah Johnson",
          "email": "sarah.johnson@company.com"
        }
      ],
      "subject": "Project Status Update",
      "body": "Hi Sarah,\n\nJust wanted to give you a quick update on the marketing project. We're on track to meet our deadline next week. Let me know if you need any additional information.\n\nBest,\nJohn",
      "date": "2024-10-15T09:30:00Z",
      "attachments": [],
      "spam": false
    },
    {
      "id": "2",
      "from": {
        "name": "Emily Chen",
        "email": "emily.chen@company.com"
      },
      "to": [
        {
          "name": "Michael Brown",
          "email": "michael.brown@company.com"
        },
        {
          "name": "David Lee",
          "email": "david.lee@company.com"
        }
      ],
      "cc": [
        {
          "name": "Sarah Johnson",
          "email": "sarah.johnson@company.com"
        }
      ],
      "subject": "Team Meeting - Agenda",
      "body": "Hello everyone,\n\nI'm sending out the agenda for our team meeting tomorrow at 2 PM. Please review and let me know if you have any topics to add.\n\n1. Project updates\n2. Budget review\n3. Upcoming deadlines\n4. Open discussion\n\nThanks,\nEmily",
      "date": "2024-10-15T14:45:00Z",
      "attachments": [
        {
          "filename": "meeting_agenda.pdf",
          "size": 1024567
        }
      ],
      "spam": false
    },
    {
      "id": "3",
      "from": {
        "name": "David Lee",
        "email": "david.lee@company.com"
      },
      "to": [
        {
          "name": "John Smith",
          "email": "john.smith@company.com"
        }
      ],
      "subject": "Re: Client Presentation",
      "body": "Hi John,\n\nI've reviewed the client presentation you sent over. It looks great overall, but I have a few suggestions for slides 5 and 7. Can we discuss these tomorrow morning?\n\nRegards,\nDavid",
      "date": "2024-10-15T16:20:00Z",
      "attachments": [],
      "spam": false
    },
    {
      "id": "4",
      "from": {
        "name": "Sarah Johnson",
        "email": "sarah.johnson@company.com"
      },
      "to": [
        {
          "name": "All Staff",
          "email": "all-staff@company.com"
        }
      ],
      "subject": "Company Picnic - Save the Date",
      "body": "Dear all,\n\nI'm excited to announce that our annual company picnic will be held on Saturday, November 9th, at Greenfield Park. Please save the date!\n\nMore details will follow in the coming weeks. If you'd like to volunteer for the planning committee, please let me know.\n\nBest regards,\nSarah Johnson\nHR Manager",
      "date": "2024-10-16T10:00:00Z",
      "attachments": [],
      "spam": false
    },
    {
      "id": "5",
      "from": {
        "name": "Amazing Deals",
        "email": "noreply@amazingdeals.com"
      },
      "to": [
        {
          "name": "John Smith",
          "email": "john.smith@company.com"
        }
      ],
      "subject": "EXCLUSIVE OFFER: 90% OFF Limited Time Only!!!",
      "body": "Dear Valued Customer,\n\nDON'T MISS OUT on this INCREDIBLE OFFER! For the next 24 hours, get 90% OFF on all our premium products. Click now to claim your discount before it's gone forever!\n\nwww.amazingdeals-totally-not-a-scam.com\n\nHurry, time is running out!",
      "date": "2024-10-16T11:15:00Z",
      "attachments": [],
      "spam": true
    },
    {
      "id": "6",
      "from": {
        "name": "Prince Nzinga",
        "email": "prince.nzinga@royalfamily.com"
      },
      "to": [
        {
          "name": "Sarah Johnson",
          "email": "sarah.johnson@company.com"
        }
      ],
      "subject": "Urgent: Confidential Business Proposal",
      "body": "Dear Esteemed Partner,\n\nI am Prince Nzinga of the Royal Family. I have a highly confidential and lucrative business proposal for you. I need your assistance to transfer $50 million USD from my country. In return, you will receive 20% of the total sum.\n\nPlease reply urgently with your bank details to proceed.\n\nYours sincerely,\nPrince Nzinga",
      "date": "2024-10-16T13:30:00Z",
      "attachments": [],
      "spam": true
    },
    {
      "id": "7",
      "from": {
        "name": "LuxeWatches",
        "email": "sales@luxe-watches-definitely-real.com"
      },
      "to": [
        {
          "name": "Michael Brown",
          "email": "michael.brown@company.com"
        }
      ],
      "subject": "Authentic Luxury Watches at Unbelievable Prices!",
      "body": "Hello Watch Enthusiast,\n\nDon't miss this opportunity to own a genuine luxury timepiece at a fraction of the retail price! Our watches are 100% authentic and come with a lifetime guarantee.\n\nRolex, Omega, Cartier, and more! Prices start at just $99.99!\n\nClick here to view our collection: www.totally-real-luxury-watches.com\n\nLimited stock available. Buy now!",
      "date": "2024-10-16T15:45:00Z",
      "attachments": [],
      "spam": true
    }
  ]
}

---

show emails as a directed graph using d3, the nodes are messages with tooltips to show content. For each message, loop over all other messages and add edges between based on overlapping email addresses of the participants. This produces a visualization of the communication network. Label the edges with the email address that defines it. Think step by step to construct the d3 graph in a valid order.

---

Spam blasting minigame. Email messages appear as short previews with sender + subject visible and they bounce around the screen in 2D like a DVD screensaver. The user has to time their clicks them to "shoot" spam,  blowing it up with a comedic "SPAM!" effect. The marked messages are stored in a queue.

If all messages are destroyed pop up a dramatic "INBOX ZERO" message.
